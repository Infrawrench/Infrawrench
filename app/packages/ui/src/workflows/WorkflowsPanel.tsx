import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import {
  isValidCronTimezone,
  nextCronOccurrences,
  validateCronExpression,
} from "@infrawrench/client-core";

import { ApprovalCard } from "./ApprovalCard.js";
import { WorkflowEditorView } from "./WorkflowEditorView.js";
import type {
  BudgetIntegration,
  BudgetOption,
  DebugSession,
  GitIntegration,
  WorkflowApprovalRow,
  WorkflowClient,
  WorkflowMetricDef,
  WorkflowMetricRow,
  WorkflowRunLog,
  WorkflowRunResult,
  WorkflowRunRow,
  WorkflowSummary,
  WorkflowTrigger,
} from "./types.js";

function metricTsType(type: WorkflowMetricDef["type"]): string {
  return type === "number" ? "number" : type === "boolean" ? "boolean" : "string";
}

/**
 * Render the `InfraMetrics` interface for a set of declared metrics. Mirrors
 * the server-side codegen (`generateInfraDts`) byte-for-byte so the live
 * overlay below and the saved typings agree (no hover flicker after Save).
 */
function renderMetricsInterface(defs: WorkflowMetricDef[]): string {
  if (defs.length === 0) {
    return "interface InfraMetrics {\n  [key: string]: number | string | boolean | null;\n}";
  }
  const props = defs
    .map((m) => {
      const prop = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(m.key) ? m.key : JSON.stringify(m.key);
      const unit = m.unit ? ` (${m.unit})` : "";
      return `  /** ${m.label}${unit} — read/write; \`null\` until first set. */\n  ${prop}: ${metricTsType(m.type)} | null;`;
    })
    .join("\n");
  return `interface InfraMetrics {\n${props}\n}`;
}

/**
 * Swap the `InfraMetrics` block in the generated typings for one reflecting the
 * metrics the user is *currently* editing, so `infra.metrics.<key>` is typed
 * live — before the workflow is even saved.
 */
function overlayMetricTypings(dts: string, defs: WorkflowMetricDef[]): string {
  const block = renderMetricsInterface(defs);
  const re = /interface InfraMetrics \{[\s\S]*?\n\}/;
  return re.test(dts) ? dts.replace(re, block) : `${dts}\n${block}\n`;
}

const STARTER_SOURCE = `// Workflow — runs in a sandboxed isolate with a typed \`infra\` object.
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

type TriggerKind = WorkflowTrigger["kind"];

/**
 * What the server knows about the selected workflow. These four values are
 * always replaced as a set — cleared on selection, reloaded after a save or a
 * run — so one action keeps them consistent instead of four setState calls.
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
    // belong to the previous workflow and must go immediately.
    case "cleared":
      return { ...state, approvals: [] };
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
}

type RunSessionAction =
  | { kind: "cleared" }
  | { kind: "started" }
  | { kind: "line"; line: number }
  | { kind: "log"; entry: WorkflowRunLog }
  | { kind: "paused"; line: number }
  | { kind: "resumed" }
  | { kind: "finished"; result: WorkflowRunResult }
  | { kind: "settled" };

const IDLE_RUN: RunSession = {
  running: false,
  liveLogs: [],
  currentLine: null,
  pausedLine: null,
  lastRun: null,
};

function runSessionReducer(state: RunSession, action: RunSessionAction): RunSession {
  switch (action.kind) {
    case "cleared":
      return { ...state, lastRun: null };
    case "started":
      return { ...state, running: true, liveLogs: [], currentLine: null, pausedLine: null };
    case "line":
      return { ...state, currentLine: action.line };
    case "log":
      return { ...state, liveLogs: [...state.liveLogs, action.entry] };
    case "paused":
      return { ...state, pausedLine: action.line };
    case "resumed":
      return { ...state, pausedLine: null };
    case "finished":
      return { ...state, lastRun: action.result };
    // The run ended (cleanly or not): stop reporting a position, but keep
    // liveLogs so the log panel still shows what happened.
    case "settled":
      return { ...state, running: false, currentLine: null, pausedLine: null };
  }
}

export function WorkflowsPanel({
  client,
  gitTriggers = false,
  gitIntegration,
  budgetIntegration,
}: WorkflowsPanelProps) {
  const [list, setList] = useState<WorkflowSummary[]>([]);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<WorkflowSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The selected workflow's server state — typings, run history, metrics, and
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
    }
  }, [client]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  const refreshApprovals = useCallback(
    async (workflowId: string) => {
      if (!client.listPendingApprovals) return;
      try {
        dispatchDetail({
          kind: "approvals",
          approvals: await client.listPendingApprovals(workflowId),
        });
      } catch {
        // Approvals are decoration on the run view — never surface a poll
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
        const [typings, runRows, metricRows] = await Promise.all([
          client.getTypings(id),
          client.listRuns(id),
          client.listMetrics(id),
        ]);
        dispatchDetail({ kind: "loaded", dts: typings, runs: runRows, metrics: metricRows });
      } catch (e) {
        setError(messageOf(e));
      }
    },
    [client, list],
  );

  const createWorkflow = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await client.create({
        name: "Untitled workflow",
        source: STARTER_SOURCE,
        trigger: { kind: "manual" },
        metrics: [],
        enabled: true,
      });
      await refreshList();
      await selectWorkflow(created.id);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }, [client, refreshList, selectWorkflow]);

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
        enabled: draft.enabled,
      });
      await refreshList();
      // Metrics may have changed → regenerate typings.
      dispatchDetail({ kind: "typings", dts: await client.getTypings(draft.id) });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }, [client, draft, refreshList]);

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
      const { result } = await client.run(draft.id, debug);
      dispatchSession({ kind: "finished", result });
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
      setSelectedId(null);
      setDraft(null);
      await refreshList();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }, [client, draft, refreshList]);

  const patch = useCallback((p: Partial<WorkflowSummary>) => {
    setDraft((d) => (d ? { ...d, ...p } : d));
  }, []);

  // The accounts portion of the typings comes from the host (getTypings); the
  // metrics portion is overlaid live from the draft so `infra.metrics.<key>`
  // reflects edits in the metrics section immediately, before saving.
  // Depend on the metric defs alone, not the whole draft — `draft.source`
  // changes on every keystroke and re-overlaying the typings each time is
  // wasted work.
  const metricDefs = draft?.metricDefs;
  const liveDts = useMemo(
    () => (metricDefs ? overlayMetricTypings(detail.dts, metricDefs) : detail.dts),
    [detail.dts, metricDefs],
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
          <span className="font-semibold text-sm">Workflows</span>
          <button
            type="button"
            onClick={() => void createWorkflow()}
            disabled={busy}
            className="text-xs px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50"
          >
            + New
          </button>
        </div>
        <div className="p-2 border-b border-white/10">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search workflows…"
            aria-label="Search workflows"
            className="w-full bg-transparent border border-white/15 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500"
          />
        </div>
        <div className="flex-1 overflow-auto">
          {list.length === 0 ? (
            <div className="p-4 text-xs opacity-60">
              No workflows yet. Create one to get started.
            </div>
          ) : filteredList.length === 0 ? (
            <div className="p-4 text-xs opacity-60">No workflows match your search.</div>
          ) : (
            filteredList.map((wf) => (
              <WorkflowListRow
                key={wf.id}
                workflow={wf}
                selected={wf.id === selectedId}
                onClick={() => void selectWorkflow(wf.id)}
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
              placeholder="Workflow name"
              aria-label="Workflow name"
            />
            <label className="text-xs flex items-center gap-1">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => patch({ enabled: e.target.checked })}
              />
              Enabled
            </label>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className="text-xs px-3 py-1 rounded bg-white/10 hover:bg-white/20 disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => void run()}
              disabled={session.running}
              className="text-xs px-3 py-1 rounded bg-green-600 hover:bg-green-500 disabled:opacity-50"
            >
              {session.running
                ? session.pausedLine != null
                  ? `Paused : ${session.pausedLine}`
                  : "Running…"
                : "Run"}
            </button>
            {session.running && session.pausedLine != null && (
              <>
                <button
                  type="button"
                  onClick={resumeRun}
                  className="text-xs px-3 py-1 rounded bg-amber-600 hover:bg-amber-500"
                  title="Continue to the next breakpoint"
                >
                  Resume
                </button>
                <button
                  type="button"
                  onClick={stepRun}
                  className="text-xs px-3 py-1 rounded bg-white/10 hover:bg-white/20"
                  title="Run the next line, then pause"
                >
                  Step
                </button>
              </>
            )}
            {session.running && (
              <button
                type="button"
                onClick={stopRun}
                className="text-xs px-3 py-1 rounded bg-red-600/80 hover:bg-red-500"
                title="Abort the run"
              >
                Stop
              </button>
            )}
            <button
              type="button"
              onClick={() => void remove()}
              disabled={busy}
              className="text-xs px-3 py-1 rounded bg-red-600/80 hover:bg-red-500 disabled:opacity-50"
            >
              Delete
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

          {error && (
            <div className="px-3 py-2 text-xs text-red-400 border-b border-white/10">{error}</div>
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
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-sm opacity-50">
          Select or create a workflow.
        </div>
      )}
    </div>
  );
}

/**
 * A workflow row in the panel list. Draggable onto a dashboard (sidebar tab or
 * the dashboard surface) to pin its metrics — see DndShell
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
          {workflow.enabled ? "" : " · disabled"}
        </div>
      </button>
    </div>
  );
}

const CRON_PRESETS: { label: string; value: string }[] = [
  { label: "Every minute", value: "* * * * *" },
  { label: "Every 5 minutes", value: "*/5 * * * *" },
  { label: "Every 15 minutes", value: "*/15 * * * *" },
  { label: "Every 30 minutes", value: "*/30 * * * *" },
  { label: "Hourly", value: "0 * * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Daily at midnight", value: "0 0 * * *" },
  { label: "Daily at 9am", value: "0 9 * * *" },
  { label: "Weekly (Mon 9am)", value: "0 9 * * 1" },
  { label: "Monthly (1st)", value: "0 0 1 * *" },
];

const CRON_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad2 = (n: number) => String(n).padStart(2, "0");

/** A best-effort plain-English summary of a 5-field cron expression. */
function describeCron(expr: string): string {
  const t = expr.trim();
  const preset = CRON_PRESETS.find((p) => p.value === t);
  if (preset) return `Runs ${preset.label.toLowerCase()}.`;
  const parts = t.split(/\s+/);
  if (parts.length !== 5) return "Enter 5 fields: minute hour day month weekday.";
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  const isNum = (s: string) => /^\d+$/.test(s);
  const everyMin = /^\*\/(\d+)$/.exec(min);
  const everyHour = /^\*\/(\d+)$/.exec(hour);
  const allDate = dom === "*" && mon === "*";
  if (everyMin && hour === "*" && allDate && dow === "*")
    return `Runs every ${everyMin[1]} minutes.`;
  if (min === "0" && everyHour && allDate && dow === "*")
    return `Runs every ${everyHour[1]} hours.`;
  if (isNum(min) && isNum(hour) && allDate && dow === "*")
    return `Runs daily at ${pad2(+hour)}:${pad2(+min)}.`;
  if (isNum(min) && isNum(hour) && allDate && isNum(dow))
    return `Runs weekly on ${CRON_DAYS[+dow % 7]} at ${pad2(+hour)}:${pad2(+min)}.`;
  if (isNum(min) && hour === "*" && allDate && dow === "*") return `Runs hourly at :${pad2(+min)}.`;
  return "Runs on a custom schedule.";
}

/** Default threshold for a new budget trigger — "goes over budget". */
const DEFAULT_BUDGET_PERCENT = 100;

/** Format a budget's monthly limit for the trigger summary line. */
function formatBudgetAmount(amountCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(0)} ${currency}`;
  }
}

function TriggerEditor({
  trigger,
  gitTriggers = false,
  gitIntegration,
  budgetIntegration,
  onChange,
  hasWebhookSecret = false,
  webhookSecret = null,
  onWebhookSecretChange,
}: {
  trigger: WorkflowTrigger;
  gitTriggers?: boolean;
  gitIntegration?: GitIntegration | undefined;
  budgetIntegration?: BudgetIntegration | undefined;
  onChange: (t: WorkflowTrigger) => void;
  /** A signing secret is already stored (the value itself is never returned). */
  hasWebhookSecret?: boolean;
  /** Pending new secret in this edit session, if the user is typing one. */
  webhookSecret?: string | null;
  onWebhookSecretChange?: (value: string | null) => void;
}) {
  const kind = trigger.kind;
  const triggerSelectId = useId();
  return (
    <div className="px-3 py-2 border-b border-white/10 flex items-center gap-2 flex-wrap text-xs">
      <label htmlFor={triggerSelectId} className="opacity-60">
        Trigger
      </label>
      <select
        id={triggerSelectId}
        value={kind}
        onChange={(e) => {
          const k = e.target.value as TriggerKind;
          if (k === "manual") onChange({ kind: "manual" });
          else if (k === "cron") onChange({ kind: "cron", expression: "0 * * * *" });
          else if (k === "budget")
            onChange({
              kind: "budget",
              budgetId: budgetIntegration?.budgets[0]?.id ?? "",
              percent: DEFAULT_BUDGET_PERCENT,
              metric: "actual",
            });
          else onChange({ kind: "git", events: ["push"] });
        }}
        className="bg-transparent border border-white/15 rounded px-2 py-1"
      >
        <option value="manual">Manual</option>
        <option value="cron">Cron</option>
        {/* Git triggers need an always-on host to watch the repo — web/proxy only. */}
        {(gitTriggers || kind === "git") && <option value="git">Git</option>}
        {/* Budgets are a cloud feature; the crossing is evaluated server-side. */}
        {(budgetIntegration || kind === "budget") && <option value="budget">Budget</option>}
      </select>
      {trigger.kind === "cron" && <CronTriggerFields trigger={trigger} onChange={onChange} />}
      {trigger.kind === "git" && (
        <div className="flex flex-wrap items-center gap-2">
          {!gitIntegration?.configured ? (
            <span className="opacity-60">GitHub isn’t configured on this server.</span>
          ) : gitIntegration.repos.length === 0 ? (
            <>
              <button
                type="button"
                onClick={gitIntegration.onConnect}
                className="px-2 py-1 rounded bg-white/10 hover:bg-white/20"
              >
                Connect GitHub
              </button>
              <span className="opacity-50">
                {gitIntegration.loading ? "Loading…" : "Install the app and pick repos to watch."}
              </span>
            </>
          ) : (
            <>
              <select
                value={trigger.repo ?? ""}
                onChange={(e) => {
                  const repo = gitIntegration.repos.find((r) => r.fullName === e.target.value);
                  onChange(
                    repo
                      ? {
                          kind: "git",
                          provider: "github",
                          repo: repo.fullName,
                          installationId: repo.installationId,
                          branch: trigger.branch || repo.defaultBranch,
                          events: trigger.events ?? ["push"],
                        }
                      : { kind: "git", events: trigger.events ?? ["push"] },
                  );
                }}
                className="bg-transparent border border-white/15 rounded px-2 py-1 max-w-56"
                aria-label="Repository"
              >
                <option value="">Select a repo…</option>
                {gitIntegration.repos.map((r) => (
                  <option key={`${r.installationId}:${r.fullName}`} value={r.fullName}>
                    {r.fullName}
                  </option>
                ))}
              </select>
              <input
                value={trigger.branch ?? ""}
                onChange={(e) => onChange({ ...trigger, branch: e.target.value })}
                placeholder="branch"
                className="bg-transparent border border-white/15 rounded px-2 py-1 w-28 font-mono"
                aria-label="Branch"
              />
              <button
                type="button"
                onClick={gitIntegration.onConnect}
                title="Add or remove repositories on GitHub"
                className="opacity-60 hover:opacity-100 px-1.5 py-1 rounded hover:bg-white/10"
              >
                + repos
              </button>
              <span className="opacity-50">Runs on each new commit to the branch.</span>
            </>
          )}
          <WebhookSecretField
            hasWebhookSecret={hasWebhookSecret}
            webhookSecret={webhookSecret}
            onChange={onWebhookSecretChange}
          />
        </div>
      )}
      {trigger.kind === "budget" && (
        <BudgetTriggerFields
          trigger={trigger}
          budgets={budgetIntegration?.budgets ?? []}
          loading={budgetIntegration?.loading ?? false}
          onChange={onChange}
        />
      )}
      {kind === "manual" && <span className="opacity-50">infra.prompt() available</span>}
    </div>
  );
}

/**
 * Cron-trigger controls: preset picker, raw 5-field expression, optional IANA
 * timezone, and a live preview of the next few run times. The preview is
 * computed by the same shared cron engine the schedulers (cloud poller,
 * desktop cron runner) fire from, so what it shows is what will happen.
 */
function CronTriggerFields({
  trigger,
  onChange,
}: {
  trigger: Extract<WorkflowTrigger, { kind: "cron" }>;
  onChange: (t: WorkflowTrigger) => void;
}) {
  const expression = trigger.expression;
  const timezone = trigger.timezone?.trim() ?? "";

  const cronError = useMemo(() => validateCronExpression(expression), [expression]);
  const timezoneError = useMemo(
    () => (timezone && !isValidCronTimezone(timezone) ? `Unknown timezone "${timezone}"` : null),
    [timezone],
  );

  const nextRuns = useMemo(() => {
    if (cronError || timezoneError) return [];
    try {
      return nextCronOccurrences(expression, 3, timezone ? { timezone } : {});
    } catch {
      return [];
    }
  }, [expression, timezone, cronError, timezoneError]);

  const formatRun = useMemo(() => {
    try {
      // Show run times in the zone the schedule is evaluated in (UTC when
      // unset) — a "daily at 09:00" cron previews as 09:00, not the viewer's
      // local rendering of it.
      const dtf = new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: timezone || "UTC",
      });
      return (d: Date) => dtf.format(d);
    } catch {
      return (d: Date) => d.toISOString();
    }
  }, [timezone]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={
          CRON_PRESETS.some((p) => p.value === expression.trim()) ? expression.trim() : "custom"
        }
        onChange={(e) => {
          if (e.target.value !== "custom") onChange({ ...trigger, expression: e.target.value });
        }}
        className="bg-transparent border border-white/15 rounded px-2 py-1"
        aria-label="Schedule preset"
      >
        {CRON_PRESETS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
        <option value="custom">Custom…</option>
      </select>
      <div className="flex flex-col items-center leading-none">
        <input
          value={expression}
          onChange={(e) => onChange({ ...trigger, expression: e.target.value })}
          placeholder="* * * * *"
          spellCheck={false}
          aria-label="Cron expression"
          className="bg-surface-overlay border border-white/15 rounded px-2 py-1 font-mono w-36 text-center tracking-[0.3em]"
        />
        <span className="mt-0.5 text-[9px] text-on-surface-faint tracking-tight">
          min&nbsp;&nbsp;hour&nbsp;&nbsp;day&nbsp;&nbsp;mon&nbsp;&nbsp;wkday
        </span>
      </div>
      <input
        value={trigger.timezone ?? ""}
        onChange={(e) => {
          const tz = e.target.value;
          // Keep the property absent (not "") when cleared, matching storage.
          const { timezone: _drop, ...rest } = trigger;
          onChange(tz ? { ...rest, timezone: tz } : rest);
        }}
        placeholder="UTC"
        spellCheck={false}
        aria-label="Timezone (IANA name, defaults to UTC)"
        title="IANA timezone the schedule runs in, e.g. Europe/London. Leave empty for UTC."
        className="bg-transparent border border-white/15 rounded px-2 py-1 w-32 font-mono"
      />
      {cronError || timezoneError ? (
        <span className="text-[11px] text-red-400">{cronError ?? timezoneError}</span>
      ) : (
        <span className="text-[11px] text-blue-300/80" title={expression}>
          {describeCron(expression)}
          {nextRuns.length > 0 && (
            <>
              {" "}
              Next: {nextRuns.map(formatRun).join(" · ")}
              {timezone ? ` (${timezone})` : " (UTC)"}
            </>
          )}
          {nextRuns.length === 0 && " This schedule never matches a run time."}
        </span>
      )}
    </div>
  );
}

/**
 * Budget-trigger controls: which budget, at what percentage of its monthly
 * amount, measured against month-to-date spend or the month-end forecast. The
 * crossing fires at most once per calendar month (editing any of these three
 * re-arms it), and the workflow receives the details as `infra.event`.
 */
function BudgetTriggerFields({
  trigger,
  budgets,
  loading,
  onChange,
}: {
  trigger: Extract<WorkflowTrigger, { kind: "budget" }>;
  budgets: BudgetOption[];
  loading: boolean;
  onChange: (t: WorkflowTrigger) => void;
}) {
  const percent = trigger.percent ?? DEFAULT_BUDGET_PERCENT;
  const metric = trigger.metric ?? "actual";
  const selected = budgets.find((b) => b.id === trigger.budgetId);

  if (budgets.length === 0) {
    return (
      <span className="opacity-60">
        {loading ? "Loading budgets…" : "No budgets yet — create one on a dashboard first."}
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={trigger.budgetId}
        onChange={(e) => onChange({ ...trigger, budgetId: e.target.value })}
        className="bg-transparent border border-white/15 rounded px-2 py-1 max-w-56"
        aria-label="Budget"
      >
        <option value="">Select a budget…</option>
        {budgets.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      <span className="opacity-60">goes over</span>
      <input
        type="number"
        min={1}
        value={percent}
        onChange={(e) => {
          const next = Number(e.target.value);
          onChange({ ...trigger, percent: next > 0 ? next : DEFAULT_BUDGET_PERCENT });
        }}
        className="bg-surface-overlay border border-white/15 rounded px-2 py-1 w-16 text-right font-mono"
        aria-label="Budget threshold percent"
      />
      <span className="opacity-60">% of</span>
      <select
        value={metric}
        onChange={(e) =>
          onChange({ ...trigger, metric: e.target.value === "forecast" ? "forecast" : "actual" })
        }
        className="bg-transparent border border-white/15 rounded px-2 py-1"
        aria-label="Budget measure"
      >
        <option value="actual">spend so far</option>
        <option value="forecast">forecast spend</option>
      </select>
      {selected && (
        <span className="text-[11px] text-blue-300/80">
          Runs once a month, when {metric === "actual" ? "spend" : "the month-end forecast"} reaches{" "}
          {formatBudgetAmount(
            Math.round((selected.amountCents * percent) / 100),
            selected.currency,
          )}{" "}
          of {formatBudgetAmount(selected.amountCents, selected.currency)}.
        </span>
      )}
    </div>
  );
}

/**
 * Signing secret for a git webhook. Write-only: once saved the server only
 * reports that one exists, so the field shows a "Configured" state with the
 * option to replace or remove it rather than echoing the value back.
 */
function WebhookSecretField({
  hasWebhookSecret,
  webhookSecret,
  onChange,
}: {
  hasWebhookSecret: boolean;
  webhookSecret: string | null;
  onChange?: ((value: string | null) => void) | undefined;
}) {
  const fieldId = useId();
  if (!onChange) return null;

  // Configured, and the user hasn't started replacing it this session.
  if (hasWebhookSecret && webhookSecret === null) {
    return (
      <span className="flex items-center gap-1.5">
        <span className="text-emerald-300/80" title="Deliveries must carry a valid signature">
          Signed ✓
        </span>
        <button
          type="button"
          onClick={() => onChange("")}
          className="opacity-60 hover:opacity-100 px-1.5 py-1 rounded hover:bg-white/10"
        >
          Replace
        </button>
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1.5">
      <label htmlFor={fieldId} className="opacity-60">
        Signing secret
      </label>
      <input
        id={fieldId}
        type="password"
        value={webhookSecret ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder="optional, but recommended"
        autoComplete="off"
        spellCheck={false}
        className="bg-surface-overlay border border-white/15 rounded px-2 py-1 w-44 font-mono"
      />
      {hasWebhookSecret && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="opacity-60 hover:opacity-100 px-1.5 py-1 rounded hover:bg-white/10"
        >
          Cancel
        </button>
      )}
    </span>
  );
}

function MetricsEditor({
  defs,
  values,
  onChange,
}: {
  defs: WorkflowMetricDef[];
  values: WorkflowMetricRow[];
  onChange: (defs: WorkflowMetricDef[]) => void;
}) {
  const valueByKey = useMemo(() => {
    const m = new Map<string, unknown>();
    for (const v of values) m.set(v.key, v.value);
    return m;
  }, [values]);

  const update = (i: number, p: Partial<WorkflowMetricDef>) => {
    onChange(defs.map((d, idx) => (idx === i ? { ...d, ...p } : d)));
  };

  return (
    <div className="px-3 py-2 border-b border-white/10 text-xs">
      <div className="flex items-center justify-between mb-1">
        <span className="opacity-60">Metrics</span>
        <button
          type="button"
          onClick={() =>
            onChange([
              ...defs,
              { key: `metric${defs.length + 1}`, label: "Metric", type: "number" },
            ])
          }
          className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20"
        >
          + Add metric
        </button>
      </div>
      {defs.length === 0 && (
        <div className="opacity-50">No metrics. Add one to read/write it from the workflow.</div>
      )}
      {defs.map((d, i) => (
        <div key={i} className="flex items-center gap-1 mb-1 flex-wrap">
          <input
            value={d.key}
            onChange={(e) => update(i, { key: e.target.value })}
            placeholder="key"
            aria-label="Metric key"
            className="bg-transparent border border-white/15 rounded px-1 py-0.5 w-28 font-mono"
          />
          <input
            value={d.label}
            onChange={(e) => update(i, { label: e.target.value })}
            placeholder="label"
            aria-label="Metric label"
            className="bg-transparent border border-white/15 rounded px-1 py-0.5 w-32"
          />
          <select
            value={d.type}
            onChange={(e) => update(i, { type: e.target.value as WorkflowMetricDef["type"] })}
            aria-label="Metric type"
            className="bg-transparent border border-white/15 rounded px-1 py-0.5"
          >
            <option value="number">number</option>
            <option value="string">string</option>
            <option value="boolean">boolean</option>
          </select>
          <input
            value={d.unit ?? ""}
            onChange={(e) => update(i, { unit: e.target.value })}
            placeholder="unit"
            aria-label="Metric unit"
            className="bg-transparent border border-white/15 rounded px-1 py-0.5 w-16"
          />
          <span className="opacity-60">= {String(valueByKey.get(d.key) ?? "—")}</span>
          <button
            type="button"
            onClick={() => onChange(defs.filter((_, idx) => idx !== i))}
            aria-label={`Remove metric ${d.key || d.label || i + 1}`}
            title={`Remove metric ${d.key || d.label || i + 1}`}
            className="px-1 opacity-60 hover:opacity-100"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Pending `infra.waitForApproval(...)` requests for the selected workflow's
 * runs, each with Approve/Deny. Approving lets the suspended run continue
 * within a few seconds; denying (or letting the timeout pass) fails it.
 *
 * The rows themselves are {@link ApprovalCard}, shared with the org-wide
 * approvals inbox — the workflow is already obvious from context here, so it
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

function RunResultPanel({ run }: { run: WorkflowRunResult }) {
  return (
    <div className="h-48 border-t border-white/10 flex flex-col min-h-0">
      <div className="px-3 py-1 text-xs border-b border-white/10 flex items-center gap-2">
        <span
          className={`font-semibold ${run.status === "success" ? "text-green-400" : run.status === "failure" ? "text-red-400" : ""}`}
        >
          {run.status}
        </span>
        {run.durationMs != null && <span className="opacity-50">{run.durationMs}ms</span>}
      </div>
      <div className="flex-1 overflow-auto p-2 font-mono text-[11px] leading-relaxed">
        {run.logs.map((l, i) => (
          <div
            key={i}
            className={
              l.level === "error" ? "text-red-400" : l.level === "warn" ? "text-yellow-400" : ""
            }
          >
            {l.message}
          </div>
        ))}
        {run.error && <div className="text-red-400">Error: {run.error.message}</div>}
        {run.output !== undefined && run.output !== null && (
          <pre className="mt-2 opacity-80">{JSON.stringify(run.output, null, 2)}</pre>
        )}
      </div>
    </div>
  );
}

/** Logs streamed live while a run is in progress (same colour-by-level styling). */
function LiveLogPanel({ logs }: { logs: WorkflowRunLog[] }) {
  return (
    <div className="h-48 border-t border-white/10 flex flex-col min-h-0">
      <div className="px-3 py-1 text-xs border-b border-white/10 flex items-center gap-2">
        <span className="font-semibold text-amber-400">running…</span>
      </div>
      <div className="flex-1 overflow-auto p-2 font-mono text-[11px] leading-relaxed">
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
    </div>
  );
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
