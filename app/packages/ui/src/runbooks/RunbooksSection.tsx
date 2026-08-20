import { useMemo, useState } from "react";
import { T, useGT } from "gt-react";
import {
  RUNBOOK_LIMITS,
  nextPendingStep,
  runbookProgress,
  validateRunbookInput,
  type Runbook,
  type RunbookInput,
  type RunbookRun,
  type RunbookRunStep,
  type RunbookStepInput,
  type RunbookStepKind,
  type RunbookStepStatus,
} from "@infrawrench/client-core";

export interface RunbooksSectionProps {
  /** The org's runbooks, or null while loading. */
  runbooks: Runbook[] | null;
  /** Recent runs across every runbook, or null while loading. */
  runs: RunbookRun[] | null;
  error?: string | null | undefined;
  onRetry?: (() => void) | undefined;
  /**
   * Workflows the editor offers on a `workflow` step. Empty or omitted and the
   * step kind is still offered but the picker says there are none — better than
   * hiding the kind, which would read as "runbooks cannot run workflows".
   */
  workflowOptions?: ReadonlyArray<{ id: string; name: string }> | undefined;
  /** Resource types the org has synced, for the selector. */
  resourceTypeOptions?: ReadonlyArray<{ id: string; label: string }> | undefined;
  /**
   * Editing. All three omitted ⇒ the list is read-only, which is what a host
   * without `org:settings:write` passes. Performing a runbook is deliberately
   * **not** gated on these.
   */
  onCreate?: ((input: RunbookInput) => Promise<void>) | undefined;
  onUpdate?: ((runbookId: string, patch: Partial<RunbookInput>) => Promise<void>) | undefined;
  onDelete?: ((runbookId: string) => Promise<void>) | undefined;
  /** Start performing one. Omitted, the Run button is hidden. */
  onStartRun?: ((runbookId: string) => Promise<void>) | undefined;
  onUpdateStep?:
    | ((
        runId: string,
        stepId: string,
        patch: { status: RunbookStepStatus; note?: string | null },
      ) => Promise<void>)
    | undefined;
  onCloseRun?:
    | ((runId: string, status: "completed" | "abandoned", summary: string | null) => Promise<void>)
    | undefined;
  /** Open a workflow a step names. Omitted, the step shows the name as text. */
  onOpenWorkflow?: ((workflowId: string) => void) | undefined;
}

type Gt = ReturnType<typeof useGT>;
type Tab = "runbooks" | "runs";

interface StepDraft extends RunbookStepInput {
  /** Local key for React; not sent. Steps without a server id need one. */
  localKey: string;
}

interface Draft {
  name: string;
  description: string;
  steps: StepDraft[];
  resourceTypeIds: string[];
  tagKey: string;
  tagValue: string;
  enabled: boolean;
}

const STEP_STATUS_CLASSES: Record<RunbookStepStatus, string> = {
  pending: "bg-surface-overlay text-on-surface-tertiary",
  done: "bg-emerald-500/10 text-success",
  skipped: "bg-surface-overlay text-on-surface-faint",
  failed: "bg-red-500/10 text-danger",
};

function statusLabel(gt: Gt, status: RunbookStepStatus): string {
  switch (status) {
    case "pending":
      return gt("Pending");
    case "done":
      return gt("Done");
    case "skipped":
      return gt("Skipped");
    case "failed":
      return gt("Failed");
  }
}

function kindLabel(gt: Gt, kind: RunbookStepKind): string {
  switch (kind) {
    case "manual":
      return gt("Manual");
    case "workflow":
      return gt("Workflow");
    case "link":
      return gt("Link");
  }
}

function emptyDraft(): Draft {
  return {
    name: "",
    description: "",
    steps: [],
    resourceTypeIds: [],
    tagKey: "",
    tagValue: "",
    enabled: true,
  };
}

function draftFrom(runbook: Runbook): Draft {
  return {
    name: runbook.name,
    description: runbook.description ?? "",
    steps: runbook.steps.map((step, index) => ({
      localKey: `${step.id}-${index}`,
      id: step.id,
      kind: step.kind,
      title: step.title,
      body: step.body,
      ...(step.workflowId ? { workflowId: step.workflowId } : {}),
      ...(step.url ? { url: step.url } : {}),
    })),
    resourceTypeIds: [...runbook.resourceTypeIds],
    tagKey: runbook.tagKey ?? "",
    tagValue: runbook.tagValue ?? "",
    enabled: runbook.enabled,
  };
}

function draftToInput(draft: Draft): RunbookInput {
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    steps: draft.steps.map(({ localKey: _localKey, ...step }) => step),
    resourceTypeIds: draft.resourceTypeIds,
    tagKey: draft.tagKey.trim() || null,
    tagValue: draft.tagValue.trim() || null,
    enabled: draft.enabled,
  };
}

/** A run's progress bar plus its counts. */
function ProgressBar({ steps }: { steps: readonly RunbookRunStep[] }) {
  const gt = useGT();
  const progress = runbookProgress(steps);
  return (
    <div className="min-w-40 flex-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-overlay">
        <div
          className={progress.failed > 0 ? "h-full bg-red-500/70" : "h-full bg-emerald-500/70"}
          style={{ width: `${progress.percent}%` }}
        />
      </div>
      <div className="mt-1 text-xs text-on-surface-faint">
        {gt("{done} done, {pending} pending", {
          done: progress.done,
          pending: progress.pending,
        })}
        {progress.skipped > 0 && ` · ${gt("{count} skipped", { count: progress.skipped })}`}
        {progress.failed > 0 && ` · ${gt("{count} failed", { count: progress.failed })}`}
      </div>
    </div>
  );
}

function RunCard({
  run,
  onUpdateStep,
  onCloseRun,
}: {
  run: RunbookRun;
  onUpdateStep: RunbooksSectionProps["onUpdateStep"];
  onCloseRun: RunbooksSectionProps["onCloseRun"];
}) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(run.status === "running");
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const next = nextPendingStep(run.steps);
  const live = run.status === "running";

  async function tick(step: RunbookRunStep, status: RunbookStepStatus) {
    if (!onUpdateStep) return;
    setBusy(true);
    setActionError(null);
    try {
      const note = noteDrafts[step.stepId];
      await onUpdateStep(run.id, step.stepId, {
        status,
        // Only send a note when one was typed: an empty box must not erase a
        // note somebody left earlier.
        ...(note !== undefined && note.trim() !== "" ? { note: note.trim() } : {}),
      });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function close(status: "completed" | "abandoned") {
    if (!onCloseRun) return;
    setBusy(true);
    setActionError(null);
    try {
      await onCloseRun(run.id, status, null);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="text-sm font-medium text-on-surface underline-offset-2 hover:underline"
        >
          {run.runbookName}
        </button>
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${
            live
              ? "bg-amber-500/10 text-warning"
              : run.status === "completed"
                ? "bg-emerald-500/10 text-success"
                : "bg-surface-overlay text-on-surface-faint"
          }`}
        >
          {live ? gt("Running") : run.status === "completed" ? gt("Completed") : gt("Abandoned")}
        </span>
        <span className="text-xs text-on-surface-tertiary">
          {run.startedByName ? gt("Started by {name}", { name: run.startedByName }) : gt("Started")}{" "}
          {new Date(run.startedAt).toLocaleString()}
        </span>
        <ProgressBar steps={run.steps} />
        {live && onCloseRun && (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void close("completed")}
              className="rounded-lg bg-accent px-2.5 py-1 text-xs font-medium text-on-accent disabled:opacity-50"
            >
              {gt("Complete")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void close("abandoned")}
              className="rounded-lg border border-border px-2.5 py-1 text-xs text-on-surface-tertiary disabled:opacity-50"
            >
              {gt("Abandon")}
            </button>
          </div>
        )}
      </div>

      {live && next && (
        <p className="mt-2 text-xs text-on-surface-tertiary">
          {gt("Next: {title}", { title: next.title })}
        </p>
      )}

      {actionError && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {actionError}
        </p>
      )}

      {expanded && (
        <ol className="mt-3 flex flex-col gap-2">
          {run.steps.map((step, index) => (
            <li key={step.stepId} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-xs tabular-nums text-on-surface-faint">{index + 1}</span>
                <span className="text-sm text-on-surface">{step.title}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${STEP_STATUS_CLASSES[step.status]}`}
                >
                  {statusLabel(gt, step.status)}
                </span>
                {step.actorName && (
                  <span className="text-xs text-on-surface-faint">
                    {gt("by {name}", { name: step.actorName })}
                  </span>
                )}
              </div>
              {step.note && (
                <p className="mt-1 whitespace-pre-wrap text-xs text-on-surface-secondary">
                  {step.note}
                </p>
              )}
              {live && onUpdateStep && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    value={noteDrafts[step.stepId] ?? ""}
                    onChange={(e) =>
                      setNoteDrafts((current) => ({ ...current, [step.stepId]: e.target.value }))
                    }
                    placeholder={gt("Note (optional)")}
                    className="min-w-40 flex-1 rounded-lg border border-border bg-surface px-2 py-1 text-xs text-on-surface"
                  />
                  {(["done", "skipped", "failed"] as const).map((status) => (
                    <button
                      key={status}
                      type="button"
                      disabled={busy}
                      onClick={() => void tick(step, status)}
                      className="rounded-lg border border-border px-2 py-1 text-xs text-on-surface-tertiary hover:text-on-surface disabled:opacity-50"
                    >
                      {statusLabel(gt, status)}
                    </button>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      {run.summary && (
        <p className="mt-2 whitespace-pre-wrap text-xs text-on-surface-secondary">{run.summary}</p>
      )}
    </li>
  );
}

function RunbookEditor({
  draft,
  setDraft,
  workflowOptions,
  resourceTypeOptions,
  busy,
  onSave,
  onCancel,
}: {
  draft: Draft;
  setDraft: (next: Draft) => void;
  workflowOptions: ReadonlyArray<{ id: string; name: string }>;
  resourceTypeOptions: ReadonlyArray<{ id: string; label: string }>;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const gt = useGT();

  function updateStep(index: number, patch: Partial<StepDraft>) {
    setDraft({
      ...draft,
      steps: draft.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    });
  }

  function moveStep(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= draft.steps.length) return;
    const steps = [...draft.steps];
    const [moved] = steps.splice(index, 1);
    if (moved) steps.splice(target, 0, moved);
    setDraft({ ...draft, steps });
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
      <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
        {gt("Name")}
        <input
          value={draft.name}
          maxLength={RUNBOOK_LIMITS.nameMaxLength}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder={gt("Fail over the primary database")}
          className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-on-surface"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
        {gt("When to use this")}
        <textarea
          value={draft.description}
          maxLength={RUNBOOK_LIMITS.descriptionMaxLength}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          rows={2}
          className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-on-surface"
        />
      </label>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs text-on-surface-tertiary">
          {gt("Applies to (leave empty for any resource)")}
        </legend>
        <div className="flex flex-wrap gap-1.5 text-xs">
          {resourceTypeOptions.slice(0, 60).map((option) => {
            const on = draft.resourceTypeIds.includes(option.id);
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setDraft({
                    ...draft,
                    resourceTypeIds: on
                      ? draft.resourceTypeIds.filter((id) => id !== option.id)
                      : [...draft.resourceTypeIds, option.id],
                  })
                }
                className={`rounded-full border px-2.5 py-1 transition-colors ${
                  on
                    ? "border-transparent bg-surface-overlay text-on-surface"
                    : "border-border text-on-surface-tertiary hover:text-on-surface-secondary"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
          {gt("Tag key (optional)")}
          <input
            value={draft.tagKey}
            onChange={(e) => setDraft({ ...draft, tagKey: e.target.value })}
            className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-on-surface"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
          {gt("Tag value (optional)")}
          <input
            value={draft.tagValue}
            onChange={(e) => setDraft({ ...draft, tagValue: e.target.value })}
            className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-on-surface"
          />
        </label>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs text-on-surface-tertiary">{gt("Steps")}</legend>
        {draft.steps.map((step, index) => (
          <div
            key={step.localKey}
            className="flex flex-col gap-2 rounded-lg border border-border p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs tabular-nums text-on-surface-faint">{index + 1}</span>
              <input
                value={step.title}
                maxLength={RUNBOOK_LIMITS.stepTitleMaxLength}
                onChange={(e) => updateStep(index, { title: e.target.value })}
                placeholder={gt("What to do")}
                className="min-w-40 flex-1 rounded-lg border border-border bg-surface px-2 py-1 text-sm text-on-surface"
              />
              <select
                value={step.kind}
                onChange={(e) => updateStep(index, { kind: e.target.value as RunbookStepKind })}
                aria-label={gt("Step kind")}
                className="rounded-lg border border-border bg-surface px-2 py-1 text-xs text-on-surface"
              >
                <option value="manual">{kindLabel(gt, "manual")}</option>
                <option value="workflow">{kindLabel(gt, "workflow")}</option>
                <option value="link">{kindLabel(gt, "link")}</option>
              </select>
              <button
                type="button"
                onClick={() => moveStep(index, -1)}
                aria-label={gt("Move step up")}
                className="rounded border border-border px-1.5 py-0.5 text-xs text-on-surface-tertiary"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => moveStep(index, 1)}
                aria-label={gt("Move step down")}
                className="rounded border border-border px-1.5 py-0.5 text-xs text-on-surface-tertiary"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() =>
                  setDraft({ ...draft, steps: draft.steps.filter((_, i) => i !== index) })
                }
                className="text-xs text-danger underline"
              >
                {gt("Remove")}
              </button>
            </div>

            {step.kind === "workflow" && (
              <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
                {gt("Workflow")}
                <select
                  value={step.workflowId ?? ""}
                  onChange={(e) => updateStep(index, { workflowId: e.target.value || null })}
                  className="rounded-lg border border-border bg-surface px-2 py-1 text-sm text-on-surface"
                >
                  <option value="">
                    {workflowOptions.length === 0
                      ? gt("No workflows in this organization yet")
                      : gt("Choose a workflow…")}
                  </option>
                  {workflowOptions.map((workflow) => (
                    <option key={workflow.id} value={workflow.id}>
                      {workflow.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {step.kind === "link" && (
              <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
                {gt("URL (https only)")}
                <input
                  value={step.url ?? ""}
                  onChange={(e) => updateStep(index, { url: e.target.value || null })}
                  placeholder="https://"
                  className="rounded-lg border border-border bg-surface px-2 py-1 text-sm text-on-surface"
                />
              </label>
            )}

            <textarea
              value={step.body ?? ""}
              maxLength={RUNBOOK_LIMITS.stepBodyMaxLength}
              onChange={(e) => updateStep(index, { body: e.target.value })}
              rows={2}
              placeholder={gt("Detail, commands, what 'done' looks like (Markdown)")}
              className="rounded-lg border border-border bg-surface px-2 py-1 text-xs text-on-surface"
            />
          </div>
        ))}

        <div>
          <button
            type="button"
            onClick={() =>
              setDraft({
                ...draft,
                steps: [
                  ...draft.steps,
                  {
                    localKey: `new-${draft.steps.length}-${Date.now()}`,
                    kind: "manual",
                    title: "",
                    body: "",
                  },
                ],
              })
            }
            className="rounded-lg border border-border px-2.5 py-1 text-xs text-on-surface-tertiary hover:text-on-surface"
          >
            {gt("Add step")}
          </button>
        </div>
      </fieldset>

      <label className="flex items-center gap-2 text-xs text-on-surface-tertiary">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
        />
        {gt("Offer this runbook")}
      </label>

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onSave}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent disabled:opacity-50"
        >
          {gt("Save")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-border px-3 py-1.5 text-xs text-on-surface-tertiary"
        >
          {gt("Cancel")}
        </button>
      </div>
    </div>
  );
}

/**
 * Runbooks — the checklist somebody wrote at 03:00, made runnable.
 *
 * Two views over one idea: the procedures the org has written down, and the
 * runs performed against them. A run is a snapshot, so the history says what
 * somebody was actually asked to do rather than what the document says today.
 */
export function RunbooksSection({
  runbooks,
  runs,
  error,
  onRetry,
  workflowOptions,
  resourceTypeOptions,
  onCreate,
  onUpdate,
  onDelete,
  onStartRun,
  onUpdateStep,
  onCloseRun,
  onOpenWorkflow,
}: RunbooksSectionProps) {
  const gt = useGT();
  const [tab, setTab] = useState<Tab>("runbooks");
  const [draft, setDraft] = useState<Draft | null>(null);
  /** Id of the runbook being edited; null while the draft is a new one. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const canEdit = Boolean(onCreate || onUpdate || onDelete);
  const workflows = workflowOptions ?? [];
  const types = resourceTypeOptions ?? [];
  const workflowNames = useMemo(
    () => new Map(workflows.map((workflow) => [workflow.id, workflow.name])),
    [workflows],
  );

  const liveRuns = useMemo(() => (runs ?? []).filter((run) => run.status === "running"), [runs]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      setDraft(null);
      setEditingId(null);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (!draft) return;
    const input = draftToInput(draft);
    // Validated with the same function the server uses, so the message here is
    // the message the API would have returned.
    const problem = validateRunbookInput(input);
    if (problem) {
      setActionError(problem);
      return;
    }
    if (editingId && onUpdate) void run(() => onUpdate(editingId, input));
    else if (!editingId && onCreate) void run(() => onCreate(input));
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <h1 className="text-xl font-semibold mb-1">{gt("Runbooks")}</h1>
      <T>
        <p className="text-sm text-on-surface-muted mb-6">
          The checklist somebody wrote down at 03:00, kept where the steps are actually performed. A
          step can be a note to tick off, a link, or a workflow to run — and following one leaves a
          record of who did what, which is the half a postmortem always misses.
        </p>
      </T>

      {error != null && runbooks === null && (
        <div role="alert" className="text-sm text-danger">
          {gt("Couldn't load the runbooks — {error}", { error })}{" "}
          {onRetry && (
            <button type="button" onClick={onRetry} className="underline">
              {gt("Retry")}
            </button>
          )}
        </div>
      )}
      {runbooks === null && error == null && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Loading runbooks…")}
        </p>
      )}
      {error != null && runbooks !== null && (
        <p role="alert" className="mb-4 text-xs text-danger">
          {gt("Couldn't refresh — showing what was last loaded. {error}", { error })}
        </p>
      )}

      {runbooks !== null && (
        <>
          {liveRuns.length > 0 && tab !== "runs" && (
            <button
              type="button"
              onClick={() => setTab("runs")}
              className="mb-4 block w-full rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-left text-sm text-on-surface"
            >
              {gt("{count} runs in progress — open them", { count: liveRuns.length })}
            </button>
          )}

          <div
            role="tablist"
            aria-label={gt("Runbook views")}
            className="mb-4 flex rounded-lg border border-border overflow-hidden text-xs w-fit"
          >
            {(
              [
                ["runbooks", gt("Runbooks ({count})", { count: runbooks.length })],
                ["runs", gt("Runs ({count})", { count: runs?.length ?? 0 })],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`px-3 py-1.5 transition-colors ${
                  tab === key
                    ? "bg-surface-overlay text-on-surface"
                    : "text-on-surface-tertiary hover:text-on-surface-secondary"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {actionError != null && (
            <p role="alert" className="mb-4 text-xs text-danger">
              {actionError}
            </p>
          )}

          {tab === "runbooks" && (
            <>
              {canEdit && draft === null && (
                <button
                  type="button"
                  onClick={() => {
                    setDraft(emptyDraft());
                    setEditingId(null);
                  }}
                  className="mb-4 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent"
                >
                  {gt("New runbook")}
                </button>
              )}

              {draft !== null && (
                <div className="mb-4">
                  <RunbookEditor
                    draft={draft}
                    setDraft={setDraft}
                    workflowOptions={workflows}
                    resourceTypeOptions={types}
                    busy={busy}
                    onSave={save}
                    onCancel={() => {
                      setDraft(null);
                      setEditingId(null);
                      setActionError(null);
                    }}
                  />
                </div>
              )}

              {runbooks.length === 0 ? (
                <T>
                  <p className="text-sm text-on-surface-faint">
                    No runbooks yet. The first one is usually the thing you explained to somebody
                    last week.
                  </p>
                </T>
              ) : (
                <ul className="flex flex-col gap-2">
                  {runbooks.map((runbook) => (
                    <li key={runbook.id} className="rounded-xl border border-border p-4">
                      <div className="flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedId(expandedId === runbook.id ? null : runbook.id)
                          }
                          aria-expanded={expandedId === runbook.id}
                          className="text-sm font-medium text-on-surface underline-offset-2 hover:underline"
                        >
                          {runbook.name}
                        </button>
                        {!runbook.enabled && (
                          <span className="rounded-full bg-surface-overlay px-2 py-0.5 text-xs text-on-surface-faint">
                            {gt("Not offered")}
                          </span>
                        )}
                        <span className="text-xs text-on-surface-tertiary">
                          {gt("{count} steps", { count: runbook.steps.length })}
                        </span>
                        <span className="text-xs text-on-surface-faint">
                          {runbook.runCount === 0
                            ? gt("Never run")
                            : gt("Run {count} times, last {when}", {
                                count: runbook.runCount,
                                when: runbook.lastRunAt
                                  ? new Date(runbook.lastRunAt).toLocaleDateString()
                                  : "",
                              })}
                        </span>
                        <div className="ml-auto flex gap-2">
                          {onStartRun && runbook.steps.length > 0 && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  await onStartRun(runbook.id);
                                  setTab("runs");
                                })
                              }
                              className="rounded-lg bg-accent px-2.5 py-1 text-xs font-medium text-on-accent disabled:opacity-50"
                            >
                              {gt("Run")}
                            </button>
                          )}
                          {onUpdate && (
                            <button
                              type="button"
                              onClick={() => {
                                setDraft(draftFrom(runbook));
                                setEditingId(runbook.id);
                              }}
                              className="rounded-lg border border-border px-2.5 py-1 text-xs text-on-surface-tertiary"
                            >
                              {gt("Edit")}
                            </button>
                          )}
                          {onDelete && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void run(() => onDelete(runbook.id))}
                              className="text-xs text-danger underline disabled:opacity-50"
                            >
                              {gt("Delete")}
                            </button>
                          )}
                        </div>
                      </div>

                      {runbook.description && (
                        <p className="mt-1 text-xs text-on-surface-tertiary">
                          {runbook.description}
                        </p>
                      )}

                      {expandedId === runbook.id && (
                        <ol className="mt-3 flex flex-col gap-1.5">
                          {runbook.steps.map((step, index) => (
                            <li key={step.id} className="text-xs">
                              <span className="tabular-nums text-on-surface-faint">
                                {index + 1}.{" "}
                              </span>
                              <span className="text-on-surface">{step.title}</span>{" "}
                              <span className="text-on-surface-faint">
                                ({kindLabel(gt, step.kind)}
                                {step.kind === "workflow" && step.workflowId
                                  ? `: ${workflowNames.get(step.workflowId) ?? step.workflowId}`
                                  : ""}
                                )
                              </span>
                              {step.kind === "workflow" && step.workflowId && onOpenWorkflow && (
                                <button
                                  type="button"
                                  onClick={() => onOpenWorkflow(step.workflowId!)}
                                  className="ml-1 text-on-surface-tertiary underline"
                                >
                                  {gt("open")}
                                </button>
                              )}
                              {step.body && (
                                <p className="mt-0.5 whitespace-pre-wrap pl-4 text-on-surface-tertiary">
                                  {step.body}
                                </p>
                              )}
                            </li>
                          ))}
                        </ol>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {tab === "runs" &&
            (runs === null ? (
              <p role="status" className="text-sm text-on-surface-faint">
                {gt("Loading runs…")}
              </p>
            ) : runs.length === 0 ? (
              <p className="text-sm text-on-surface-faint">{gt("Nothing has been run yet.")}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {runs.map((item) => (
                  <RunCard
                    key={item.id}
                    run={item}
                    onUpdateStep={onUpdateStep}
                    onCloseRun={onCloseRun}
                  />
                ))}
              </ul>
            ))}
        </>
      )}
    </div>
  );
}
