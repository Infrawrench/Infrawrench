import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { T, useGT } from "gt-react";
import { useDraggable } from "@dnd-kit/core";

import { ApprovalCard } from "./ApprovalCard.js";
import { LiveLogPanel, RunResultPanel, WorkflowRunHistory } from "./RunHistory.js";
import { WorkflowEditorView } from "./WorkflowEditorView.js";
import type {
  BudgetIntegration,
  DebugSession,
  GitIntegration,
  WorkflowApprovalRow,
  WorkflowClient,
  WorkflowMetricRow,
  WorkflowRunLog,
  WorkflowRunResult,
  WorkflowRunRow,
  WorkflowSecretSummary,
  WorkflowSummary,
} from "./types.js";
import { messageOf } from "./errors.js";
import { overlayMetricTypings, overlaySecretTypings } from "./workflow-typings.js";
import { SecretsEditor } from "./SecretsEditor.js";
import { MetricsEditor } from "./MetricsEditor.js";
import { TriggerEditor } from "./TriggerEditor.js";

const STARTER_SOURCE = `// Workflow: runs in a sandboxed isolate with a typed \`infra\` object.
// Example: read a JSON file from R2 and log a value.
//
// const cf = infra.accounts.cloudflare.getByName("production");
// const bucket = await cf.r2Buckets.get("configs");
// const cfg = (await bucket.get("app.json")).json<{ replicas: number }>();
// await infra.output({ replicas: cfg.replicas });

infra.log("hello from your workflow");
`;

interface WorkflowsPanelProps {
  client: WorkflowClient;
  /**
   * Which workflow the editor opens on; the host mirrors it into the URL.
   * Omit (and omit {@link onWorkflowChange}) for an uncontrolled panel.
   */
  workflowId?: string | undefined;
  /** Called when the selection changes, so the host can record it on the tab. */
  onWorkflowChange?: ((workflowId: string | null) => void) | undefined;
  /**
   * Whether git triggers are available. Off for the desktop/local client
   * (workflows live locally with no always-on host to watch a repo); on for
   * the web/proxy client, which connects GitHub and watches repos server-side.
   */
  gitTriggers?: boolean;
  /** GitHub connection + repos for the git-trigger picker (web only). */
  gitIntegration?: GitIntegration;
  /**
   * The org's cost budgets, enabling the Budget trigger. Cloud-only: budgets
   * are a cloud feature and the crossing is evaluated by the poller, so the
   * desktop/local client omits this and the option stays hidden.
   */
  budgetIntegration?: BudgetIntegration;
}

/**
 * What the server knows about the selected workflow. These four values are
 * always replaced as a set (cleared on selection, reloaded after a save or a
 * run) so one action keeps them consistent instead of four setState calls.
 */
interface WorkflowDetail {
  dts: string;
  runs: WorkflowRunRow[];
  metrics: WorkflowMetricRow[];
  approvals: WorkflowApprovalRow[];
}

type WorkflowDetailAction =
  | { kind: "cleared" }
  | { kind: "loaded"; dts: string; runs: WorkflowRunRow[]; metrics: WorkflowMetricRow[] }
  | { kind: "typings"; dts: string }
  | { kind: "runsRefreshed"; runs: WorkflowRunRow[]; metrics: WorkflowMetricRow[] }
  | { kind: "approvals"; approvals: WorkflowApprovalRow[] };

const EMPTY_DETAIL: WorkflowDetail = {
  dts: "declare const infra: any;",
  runs: [],
  metrics: [],
  approvals: [],
};

function detailReducer(state: WorkflowDetail, action: WorkflowDetailAction): WorkflowDetail {
  switch (action.kind) {
    // A newly picked workflow keeps the old typings until the fresh ones land
    // (the editor would flash an untyped `infra` otherwise), but its approvals
    // and run history belong to the previous workflow and must go immediately:
    // the history is a list of that other workflow's runs, not a placeholder.
    case "cleared":
      return { ...state, approvals: [], runs: [] };
    case "loaded":
      return { ...state, dts: action.dts, runs: action.runs, metrics: action.metrics };
    case "typings":
      return { ...state, dts: action.dts };
    case "runsRefreshed":
      return { ...state, runs: action.runs, metrics: action.metrics };
    case "approvals":
      return { ...state, approvals: action.approvals };
  }
}

/**
 * One in-flight run: whether it is going, what it has logged, where the
 * debugger sits, and the result once it lands. Starting, pausing and settling
 * each move several of these at once, so they travel as one action.
 */
interface RunSession {
  running: boolean;
  liveLogs: WorkflowRunLog[];
  currentLine: number | null;
  pausedLine: number | null;
  lastRun: WorkflowRunResult | null;
  /**
   * Id of the run this session started, known once the client returns. The run
   * history uses it to mark that row as the one already on screen above rather
   * than offering a second copy of the same logs.
   */
  lastRunId: string | null;
}

type RunSessionAction =
  | { kind: "cleared" }
  | { kind: "started" }
  | { kind: "line"; line: number }
  | { kind: "log"; entry: WorkflowRunLog }
  | { kind: "paused"; line: number }
  | { kind: "resumed" }
  | { kind: "finished"; runId: string; result: WorkflowRunResult }
  | { kind: "settled" };

const IDLE_RUN: RunSession = {
  running: false,
  liveLogs: [],
  currentLine: null,
  pausedLine: null,
  lastRun: null,
  lastRunId: null,
};

function runSessionReducer(state: RunSession, action: RunSessionAction): RunSession {
  switch (action.kind) {
    case "cleared":
      return { ...state, lastRun: null, lastRunId: null };
    case "started":
      return {
        ...state,
        running: true,
        liveLogs: [],
        currentLine: null,
        pausedLine: null,
        lastRunId: null,
      };
    case "line":
      return { ...state, currentLine: action.line };
    case "log":
      return { ...state, liveLogs: [...state.liveLogs, action.entry] };
    case "paused":
      return { ...state, pausedLine: action.line };
    case "resumed":
      return { ...state, pausedLine: null };
    case "finished":
      return { ...state, lastRun: action.result, lastRunId: action.runId || null };
    // The run ended (cleanly or not): stop reporting a position, but keep
    // liveLogs so the log panel still shows what happened.
    case "settled":
      return { ...state, running: false, currentLine: null, pausedLine: null };
  }
}

export function WorkflowsPanel({
  client,
  workflowId,
  onWorkflowChange,
  gitTriggers = false,
  gitIntegration,
  budgetIntegration,
}: WorkflowsPanelProps) {
  const gt = useGT();
  const [list, setList] = useState<WorkflowSummary[]>([]);
  const [listed, setListed] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<WorkflowSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<WorkflowSecretSummary[]>([]);
  const [secretsLoading, setSecretsLoading] = useState(true);
  // The selected workflow's server state: typings, run history, metrics, and
  // the pending infra.waitForApproval(...) requests for its runs (approvals are
  // cloud only; the desktop client omits the approval methods).
  const [detail, dispatchDetail] = useReducer(detailReducer, EMPTY_DETAIL);
  // Logs, debugger position and result for the run in flight.
  const [session, dispatchSession] = useReducer(runSessionReducer, IDLE_RUN);
  const [decidingApprovalId, setDecidingApprovalId] = useState<string | null>(null);
  // `breakpointsRef` is the live set the running client reads (so toggles
  // mid-run are seen); `breakpoints` mirrors it for the editor.
  const breakpointsRef = useRef<Set<number>>(new Set());
  const [breakpoints, setBreakpoints] = useState<Set<number>>(() => new Set());
  // The active debug session (the client fills in resume/step/stop per pause).
  const debugSessionRef = useRef<DebugSession | null>(null);
  // Bumped whenever we start a typings load so a slow enrich pass can't
  // overwrite typings for a workflow the user already left.
  const typingsEpochRef = useRef(0);

  /** Fast static surface (plugin defs + account names). Call {@link scheduleEnrichTypings} after applying it. */
  const fetchStaticTypings = useCallback(
    async (id: string): Promise<string> => {
      typingsEpochRef.current += 1;
      return client.getTypings(id);
    },
    [client],
  );

  /** Second pass: precise create() field unions. Best-effort; never blocks the editor. */
  const scheduleEnrichTypings = useCallback(
    (id: string) => {
      const epoch = typingsEpochRef.current;
      void client
        .getTypings(id, { enrich: true })
        .then((enriched) => {
          if (typingsEpochRef.current !== epoch) return;
          dispatchDetail({ kind: "typings", dts: enriched });
        })
        .catch(() => {
          // Keep the static surface.
        });
    },
    [client],
  );

  const toggleBreakpoint = useCallback((line: number) => {
    const set = breakpointsRef.current;
    if (set.has(line)) set.delete(line);
    else set.add(line);
    setBreakpoints(new Set(set));
  }, []);

  const refreshList = useCallback(async () => {
    try {
      setList(await client.list());
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setListed(true);
    }
  }, [client]);

  const refreshSecrets = useCallback(async () => {
    setSecretsLoading(true);
    try {
      setSecrets(await client.listSecrets());
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSecretsLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void refreshList();
    void refreshSecrets();
  }, [refreshList, refreshSecrets]);

  const refreshApprovals = useCallback(
    async (workflowId: string) => {
      if (!client.listPendingApprovals) return;
      try {
        dispatchDetail({
          kind: "approvals",
          approvals: await client.listPendingApprovals(workflowId),
        });
      } catch {
        // Approvals are decoration on the run view, never surface a poll
        // failure over whatever the user is actually doing.
      }
    },
    [client],
  );

  // Keep pending approvals fresh: tight while a run is executing (its
  // waitForApproval card should appear within a few seconds), relaxed
  // otherwise (an automated run's request shows without reselecting).
  useEffect(() => {
    if (!selectedId || !client.listPendingApprovals) return;
    void refreshApprovals(selectedId);
    const interval = setInterval(
      () => void refreshApprovals(selectedId),
      session.running ? 4000 : 15000,
    );
    return () => clearInterval(interval);
  }, [client, refreshApprovals, selectedId, session.running]);

  const decideApproval = useCallback(
    async (approvalId: string, decision: "approve" | "deny") => {
      if (!client.decideApproval) return;
      setDecidingApprovalId(approvalId);
      try {
        await client.decideApproval(approvalId, decision);
      } catch (e) {
        setError(messageOf(e));
      } finally {
        setDecidingApprovalId(null);
        if (selectedId) void refreshApprovals(selectedId);
      }
    },
    [client, refreshApprovals, selectedId],
  );

  const selectWorkflow = useCallback(
    async (id: string) => {
      setSelectedId(id);
      dispatchSession({ kind: "cleared" });
      dispatchDetail({ kind: "cleared" });
      const wf = list.find((w) => w.id === id);
      if (wf) setDraft(structuredCloneSafe(wf));
      try {
        const [typings, runRows, metricRows, assignment] = await Promise.all([
          fetchStaticTypings(id),
          client.listRuns(id),
          client.listMetrics(id),
          client.getAssignedSecrets(id),
        ]);
        setDraft((current) =>
          current?.id === id
            ? {
                ...current,
                assignedSecretIds: assignment.assignedSecretIds,
                assignedSecrets: assignment.secrets,
              }
            : current,
        );
        dispatchDetail({ kind: "loaded", dts: typings, runs: runRows, metrics: metricRows });
        // After the static surface is on screen, never before, or a fast
        // enrich can land and then get clobbered by the `loaded` dispatch.
        scheduleEnrichTypings(id);
      } catch (e) {
        setError(messageOf(e));
      }
    },
    [client, list, fetchStaticTypings, scheduleEnrichTypings],
  );

  // The URL owns which workflow is open when the host passes `workflowId`.
  // Wait for the first list fetch so a deep link can populate the draft from
  // the summary row. Uncontrolled mounts (tests, no onWorkflowChange) keep
  // selection local.
  useEffect(() => {
    if (!listed) return;
    if (workflowId) {
      void selectWorkflow(workflowId);
      return;
    }
    if (!onWorkflowChange) return;
    setSelectedId(null);
    setDraft(null);
    dispatchSession({ kind: "cleared" });
    dispatchDetail({ kind: "cleared" });
    // Re-selecting whenever `list` refreshes would clobber in-progress edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- URL is the source of truth.
  }, [workflowId, listed]);

  const createWorkflow = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await client.create({
        name: "Untitled workflow",
        source: STARTER_SOURCE,
        trigger: { kind: "manual" },
        metrics: [],
        assignedSecretIds: [],
        enabled: true,
      });
      await refreshList();
      onWorkflowChange?.(created.id);
      await selectWorkflow(created.id);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }, [client, onWorkflowChange, refreshList, selectWorkflow]);

  const save = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await client.update(draft.id, {
        name: draft.name,
        description: draft.description ?? null,
        source: draft.source,
        trigger: draft.trigger,
        metrics: draft.metricDefs,
        assignedSecretIds: draft.assignedSecretIds ?? [],
        enabled: draft.enabled,
      });
      await refreshList();
      // Metrics may have changed → regenerate typings (static first, enrich after).
      dispatchDetail({ kind: "typings", dts: await fetchStaticTypings(draft.id) });
      scheduleEnrichTypings(draft.id);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }, [client, draft, refreshList, fetchStaticTypings, scheduleEnrichTypings]);

  const run = useCallback(async () => {
    if (!draft) return;
    dispatchSession({ kind: "started" });
    setError(null);
    const debug: DebugSession = {
      breakpoints: breakpointsRef.current,
      onLine: (n) => dispatchSession({ kind: "line", line: n }),
      onLog: (entry) => dispatchSession({ kind: "log", entry }),
      onPaused: (n) => dispatchSession({ kind: "paused", line: n }),
      onResumed: () => dispatchSession({ kind: "resumed" }),
    };
    debugSessionRef.current = debug;
    try {
      await client.update(draft.id, { source: draft.source });
      const { runId, result } = await client.run(draft.id, debug);
      dispatchSession({ kind: "finished", runId, result });
      dispatchDetail({
        kind: "runsRefreshed",
        runs: await client.listRuns(draft.id),
        metrics: await client.listMetrics(draft.id),
      });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      dispatchSession({ kind: "settled" });
      debugSessionRef.current = null;
    }
  }, [client, draft]);

  const resumeRun = useCallback(() => debugSessionRef.current?.resume?.(), []);
  const stepRun = useCallback(() => debugSessionRef.current?.step?.(), []);
  const stopRun = useCallback(() => debugSessionRef.current?.stop?.(), []);

  const remove = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    try {
      await client.remove(draft.id);
      onWorkflowChange?.(null);
      setSelectedId(null);
      setDraft(null);
      await refreshList();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }, [client, draft, onWorkflowChange, refreshList]);

  const patch = useCallback((p: Partial<WorkflowSummary>) => {
    setDraft((d) => (d ? { ...d, ...p } : d));
  }, []);

  // The accounts portion of the typings comes from the host (getTypings); the
  // metrics portion is overlaid live from the draft so `infra.metrics.<key>`
  // reflects edits in the metrics section immediately, before saving.
  // Depend on the metric defs alone, not the whole draft: `draft.source`
  // changes on every keystroke and re-overlaying the typings each time is
  // wasted work.
  const metricDefs = draft?.metricDefs;
  const assignedSecrets = useMemo(() => {
    const assigned = new Set(draft?.assignedSecretIds ?? []);
    return secrets.filter((secret) => assigned.has(secret.id));
  }, [draft?.assignedSecretIds, secrets]);
  const liveDts = useMemo(
    () =>
      overlaySecretTypings(
        metricDefs ? overlayMetricTypings(detail.dts, metricDefs) : detail.dts,
        assignedSecrets,
      ),
    [detail.dts, metricDefs, assignedSecrets],
  );

  const filteredList = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((wf) => wf.name.toLowerCase().includes(q));
  }, [list, search]);

  return (
    <div className="flex flex-1 min-h-0">
      {/* Workflow list */}
      <div className="w-64 border-r border-white/10 flex flex-col min-h-0">
        <div className="p-3 border-b border-white/10 flex items-center justify-between">
          <span className="font-semibold text-sm">{gt("Workflows")}</span>
          <button
            type="button"
            onClick={() => void createWorkflow()}
            disabled={busy}
            className="text-xs px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50"
          >
            {gt("+ New")}
          </button>
        </div>
        <div className="p-2 border-b border-white/10">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={gt("Search workflows…")}
            aria-label={gt("Search workflows")}
            className="w-full bg-transparent border border-white/15 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500"
          />
        </div>
        <div className="flex-1 overflow-auto">
          {list.length === 0 ? (
            <div className="p-4 text-xs opacity-60">
              {gt("No workflows yet. Create one to get started.")}
            </div>
          ) : filteredList.length === 0 ? (
            <div className="p-4 text-xs opacity-60">{gt("No workflows match your search.")}</div>
          ) : (
            filteredList.map((wf) => (
              <WorkflowListRow
                key={wf.id}
                workflow={wf}
                selected={wf.id === selectedId}
                onClick={() => {
                  onWorkflowChange?.(wf.id);
                  void selectWorkflow(wf.id);
                }}
              />
            ))
          )}
        </div>
      </div>

      {/* Editor + config */}
      {draft ? (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="p-3 border-b border-white/10 flex items-center gap-2 flex-wrap">
            <input
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
              className="bg-transparent border border-white/15 rounded px-2 py-1 text-sm flex-1 min-w-40"
              placeholder={gt("Workflow name")}
              aria-label={gt("Workflow name")}
            />
            <label className="text-xs flex items-center gap-1">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => patch({ enabled: e.target.checked })}
              />
              {gt("Enabled")}
            </label>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className="text-xs px-3 py-1 rounded bg-white/10 hover:bg-white/20 disabled:opacity-50"
            >
              {gt("Save")}
            </button>
            <button
              type="button"
              onClick={() => void run()}
              disabled={session.running}
              className="text-xs px-3 py-1 rounded bg-green-600 hover:bg-green-500 disabled:opacity-50"
            >
              {session.running
                ? session.pausedLine != null
                  ? gt("Paused : {line}", { line: session.pausedLine })
                  : gt("Running…")
                : gt("Run")}
            </button>
            {session.running && session.pausedLine != null && (
              <>
                <button
                  type="button"
                  onClick={resumeRun}
                  className="text-xs px-3 py-1 rounded bg-amber-600 hover:bg-amber-500"
                  title={gt("Continue to the next breakpoint")}
                >
                  {gt("Resume")}
                </button>
                <button
                  type="button"
                  onClick={stepRun}
                  className="text-xs px-3 py-1 rounded bg-white/10 hover:bg-white/20"
                  title={gt("Run the next line, then pause")}
                >
                  {gt("Step")}
                </button>
              </>
            )}
            {session.running && (
              <button
                type="button"
                onClick={stopRun}
                className="text-xs px-3 py-1 rounded bg-red-600/80 hover:bg-red-500"
                title={gt("Abort the run")}
              >
                {gt("Stop")}
              </button>
            )}
            <button
              type="button"
              onClick={() => void remove()}
              disabled={busy}
              className="text-xs px-3 py-1 rounded bg-red-600/80 hover:bg-red-500 disabled:opacity-50"
            >
              {gt("Delete")}
            </button>
          </div>

          <TriggerEditor
            trigger={draft.trigger}
            gitTriggers={gitTriggers}
            gitIntegration={gitIntegration}
            budgetIntegration={budgetIntegration}
            onChange={(t) => patch({ trigger: t })}
            hasWebhookSecret={draft.hasWebhookSecret ?? false}
            webhookSecret={draft.webhookSecret ?? null}
            onWebhookSecretChange={(v) => patch({ webhookSecret: v })}
          />

          <MetricsEditor
            defs={draft.metricDefs}
            values={detail.metrics}
            onChange={(defs) => patch({ metricDefs: defs })}
          />

          <SecretsEditor
            secrets={secrets}
            assignedIds={draft.assignedSecretIds ?? []}
            loading={secretsLoading}
            onAssignedIdsChange={(assignedSecretIds) => patch({ assignedSecretIds })}
            onUpsert={async (input) => {
              const saved = await client.upsertSecret(input);
              await refreshSecrets();
              return saved;
            }}
            onDelete={async (id) => {
              await client.deleteSecret(id);
              patch({
                assignedSecretIds: (draft.assignedSecretIds ?? []).filter(
                  (secretId) => secretId !== id,
                ),
              });
              await refreshSecrets();
            }}
            onError={(message) => setError(message)}
          />

          {error && (
            <div className="px-3 py-2 text-xs text-danger border-b border-white/10">{error}</div>
          )}

          <div className="flex-1 min-h-0">
            <WorkflowEditorView
              value={draft.source}
              onChange={(v) => patch({ source: v })}
              dts={liveDts}
              onSave={() => void save()}
              breakpoints={breakpoints}
              onToggleBreakpoint={toggleBreakpoint}
              currentLine={session.currentLine}
              pausedLine={session.pausedLine}
            />
          </div>

          {detail.approvals.length > 0 && (
            <PendingApprovalsPanel
              approvals={detail.approvals}
              decidingId={decidingApprovalId}
              onDecide={(id, decision) => void decideApproval(id, decision)}
            />
          )}

          {session.running ? (
            <LiveLogPanel logs={session.liveLogs} />
          ) : (
            session.lastRun && <RunResultPanel run={session.lastRun} />
          )}

          <WorkflowRunHistory
            runs={detail.runs}
            currentRunId={session.lastRunId}
            liveRunActive={session.running}
          />
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-sm opacity-50">
          {gt("Select or create a workflow.")}
        </div>
      )}
    </div>
  );
}

/**
 * A workflow row in the panel list. Draggable onto a dashboard (sidebar tab or
 * the dashboard surface) to pin its metrics: see DndShell
 * `onPinWorkflowToDashboard`. Clicking (no drag past the sensor threshold)
 * selects it for editing.
 */
function WorkflowListRow({
  workflow,
  selected,
  onClick,
}: {
  workflow: WorkflowSummary;
  selected: boolean;
  onClick: () => void;
}) {
  const gt = useGT();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `sidebar-workflow:${workflow.id}`,
    data: { workflow: { id: workflow.id, name: workflow.name }, dragLabel: workflow.name },
  });

  return (
    <div ref={setNodeRef} className={isDragging ? "opacity-40" : ""} {...listeners} {...attributes}>
      <button
        type="button"
        draggable={false}
        onClick={onClick}
        className={`block w-full text-left px-3 py-2 text-sm border-b border-white/5 hover:bg-white/5 cursor-grab active:cursor-grabbing ${
          selected ? "bg-white/10" : ""
        }`}
      >
        <div className="truncate">{workflow.name}</div>
        <div className="text-[10px] opacity-50">
          {workflow.trigger.kind}
          {workflow.enabled ? "" : gt(" · disabled")}
        </div>
      </button>
    </div>
  );
}

/**
 * Pending `infra.waitForApproval(...)` requests for the selected workflow's
 * runs, each with Approve/Deny. Approving lets the suspended run continue
 * within a few seconds; denying (or letting the timeout pass) fails it.
 *
 * The rows themselves are {@link ApprovalCard}, shared with the org-wide
 * approvals inbox: the workflow is already obvious from context here, so it
 * is the one thing this surface leaves off.
 */
function PendingApprovalsPanel({
  approvals,
  decidingId,
  onDecide,
}: {
  approvals: WorkflowApprovalRow[];
  decidingId: string | null;
  onDecide: (id: string, decision: "approve" | "deny") => void;
}) {
  return (
    <div className="border-t border-amber-400/30 bg-amber-400/5">
      {approvals.map((a) => (
        <ApprovalCard key={a.id} approval={a} deciding={decidingId === a.id} onDecide={onDecide} />
      ))}
    </div>
  );
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
