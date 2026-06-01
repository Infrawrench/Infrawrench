import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDraggable } from "@dnd-kit/core";

import { WorkflowEditorView } from "./WorkflowEditorView.js";
import type {
  DebugSession,
  GitIntegration,
  WorkflowClient,
  WorkflowMetricDef,
  WorkflowMetricRow,
  WorkflowRunLog,
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
}

type TriggerKind = WorkflowTrigger["kind"];

export function WorkflowsPanel({
  client,
  gitTriggers = false,
  gitIntegration,
}: WorkflowsPanelProps) {
  const [list, setList] = useState<WorkflowSummary[]>([]);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<WorkflowSummary | null>(null);
  const [dts, setDts] = useState<string>("declare const infra: any;");
  const [runs, setRuns] = useState<WorkflowRunRow[]>([]);
  const [metrics, setMetrics] = useState<WorkflowMetricRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<WorkflowRunRow | null>(null);
  // Logs streamed live during a run (e.g. infra.log(ssh streams)).
  const [liveLogs, setLiveLogs] = useState<WorkflowRunLog[]>([]);
  // Debugger state. `breakpointsRef` is the live set the running client reads
  // (so toggles mid-run are seen); `breakpoints` mirrors it for the editor.
  const breakpointsRef = useRef<Set<number>>(new Set());
  const [breakpoints, setBreakpoints] = useState<Set<number>>(() => new Set());
  const [currentLine, setCurrentLine] = useState<number | null>(null);
  const [pausedLine, setPausedLine] = useState<number | null>(null);
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

  const selectWorkflow = useCallback(
    async (id: string) => {
      setSelectedId(id);
      setLastRun(null);
      const wf = list.find((w) => w.id === id);
      if (wf) setDraft(structuredCloneSafe(wf));
      try {
        const [typings, runRows, metricRows] = await Promise.all([
          client.getTypings(id),
          client.listRuns(id),
          client.listMetrics(id),
        ]);
        setDts(typings);
        setRuns(runRows);
        setMetrics(metricRows);
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
      setDts(await client.getTypings(draft.id));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }, [client, draft, refreshList]);

  const run = useCallback(async () => {
    if (!draft) return;
    setRunning(true);
    setError(null);
    setCurrentLine(null);
    setPausedLine(null);
    setLiveLogs([]);
    const session: DebugSession = {
      breakpoints: breakpointsRef.current,
      onLine: (n) => setCurrentLine(n),
      onLog: (entry) => setLiveLogs((prev) => [...prev, entry]),
      onPaused: (n) => setPausedLine(n),
      onResumed: () => setPausedLine(null),
    };
    debugSessionRef.current = session;
    try {
      await client.update(draft.id, { source: draft.source });
      const { result } = await client.run(draft.id, session);
      setLastRun(result);
      setRuns(await client.listRuns(draft.id));
      setMetrics(await client.listMetrics(draft.id));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setRunning(false);
      setCurrentLine(null);
      setPausedLine(null);
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
  const liveDts = useMemo(
    () => (draft ? overlayMetricTypings(dts, draft.metricDefs) : dts),
    [dts, draft?.metricDefs],
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
              disabled={running}
              className="text-xs px-3 py-1 rounded bg-green-600 hover:bg-green-500 disabled:opacity-50"
            >
              {running ? (pausedLine != null ? `Paused : ${pausedLine}` : "Running…") : "Run"}
            </button>
            {running && pausedLine != null && (
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
            {running && (
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
            onChange={(t) => patch({ trigger: t })}
          />

          <MetricsEditor
            defs={draft.metricDefs}
            values={metrics}
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
              currentLine={currentLine}
              pausedLine={pausedLine}
            />
          </div>

          {running ? <LiveLogPanel logs={liveLogs} /> : lastRun && <RunResultPanel run={lastRun} />}
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

function TriggerEditor({
  trigger,
  gitTriggers = false,
  gitIntegration,
  onChange,
}: {
  trigger: WorkflowTrigger;
  gitTriggers?: boolean;
  gitIntegration?: GitIntegration | undefined;
  onChange: (t: WorkflowTrigger) => void;
}) {
  const kind = trigger.kind;
  return (
    <div className="px-3 py-2 border-b border-white/10 flex items-center gap-2 flex-wrap text-xs">
      <span className="opacity-60">Trigger</span>
      <select
        value={kind}
        onChange={(e) => {
          const k = e.target.value as TriggerKind;
          if (k === "manual") onChange({ kind: "manual" });
          else if (k === "cron") onChange({ kind: "cron", expression: "0 * * * *" });
          else onChange({ kind: "git", events: ["push"] });
        }}
        className="bg-transparent border border-white/15 rounded px-2 py-1"
      >
        <option value="manual">Manual</option>
        <option value="cron">Cron</option>
        {/* Git triggers need an always-on host to watch the repo — web/proxy only. */}
        {(gitTriggers || kind === "git") && <option value="git">Git</option>}
      </select>
      {trigger.kind === "cron" && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={
              CRON_PRESETS.some((p) => p.value === trigger.expression.trim())
                ? trigger.expression.trim()
                : "custom"
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
              value={trigger.expression}
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
          <span className="text-[11px] text-blue-300/80" title={trigger.expression}>
            {describeCron(trigger.expression)}
          </span>
        </div>
      )}
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
        </div>
      )}
      {kind === "manual" && <span className="opacity-50">infra.prompt() available</span>}
    </div>
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
            className="bg-transparent border border-white/15 rounded px-1 py-0.5 w-28 font-mono"
          />
          <input
            value={d.label}
            onChange={(e) => update(i, { label: e.target.value })}
            placeholder="label"
            className="bg-transparent border border-white/15 rounded px-1 py-0.5 w-32"
          />
          <select
            value={d.type}
            onChange={(e) => update(i, { type: e.target.value as WorkflowMetricDef["type"] })}
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
            className="bg-transparent border border-white/15 rounded px-1 py-0.5 w-16"
          />
          <span className="opacity-60">= {String(valueByKey.get(d.key) ?? "—")}</span>
          <button
            type="button"
            onClick={() => onChange(defs.filter((_, idx) => idx !== i))}
            className="px-1 opacity-60 hover:opacity-100"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

function RunResultPanel({ run }: { run: WorkflowRunRow }) {
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
