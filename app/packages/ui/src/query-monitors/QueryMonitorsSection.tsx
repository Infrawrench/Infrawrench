import { useMemo, useState } from "react";
import { T, useGT } from "gt-react";
import {
  QUERY_MONITOR_LIMITS,
  QUERY_MONITOR_OPERATOR_LABELS,
  describeQueryMonitor,
  monitorSqlProblem,
  validateQueryMonitor,
  type QueryMonitor,
  type QueryMonitorInput,
  type QueryMonitorMode,
  type QueryMonitorOperator,
  type QueryMonitorState,
  type QueryMonitorTargetAccount,
} from "@infrawrench/client-core";

export interface QueryMonitorTestResult {
  value: number | null;
  state: QueryMonitorState;
  error: string | null;
  durationMs: number;
  rows: Record<string, unknown>[];
}

export interface QueryMonitorsSectionProps {
  monitors: QueryMonitor[] | null;
  error?: string | null | undefined;
  onRetry?: (() => void) | undefined;
  /**
   * What the query can run against: accounts with their own SQL driver, and
   * the SQL-capable resources inside each (a ClickHouse service, a D1 or
   * Turso database, a BigQuery dataset). Empty and the editor says so.
   */
  targetOptions?: ReadonlyArray<QueryMonitorTargetAccount> | undefined;
  onCreate?: ((input: QueryMonitorInput) => Promise<void>) | undefined;
  onUpdate?: ((monitorId: string, patch: Partial<QueryMonitorInput>) => Promise<void>) | undefined;
  onDelete?: ((monitorId: string) => Promise<void>) | undefined;
  /** Run the draft once without saving. Omitted, the Try it button is hidden. */
  onTest?: ((input: Partial<QueryMonitorInput>) => Promise<QueryMonitorTestResult>) | undefined;
}

type Gt = ReturnType<typeof useGT>;

interface Draft {
  name: string;
  description: string;
  accountId: string;
  /** Set when the query runs against one resource rather than the account. */
  resourceId: string | null;
  resourceTypeId: string | null;
  sql: string;
  mode: QueryMonitorMode;
  operator: QueryMonitorOperator;
  threshold: number;
  intervalMinutes: number;
  consecutiveBreaches: number;
  enabled: boolean;
}

/** One selectable row of the target picker. */
interface TargetChoice {
  key: string;
  accountId: string;
  resourceId: string | null;
  resourceTypeId: string | null;
  label: string;
}

/**
 * The select's option value. Resource ids may contain any character the
 * provider put in an external id, so the separator is a newline — the one
 * thing neither an account id nor a resource id can carry.
 */
function targetKey(accountId: string, resourceId: string | null): string {
  return `${accountId}\n${resourceId ?? ""}`;
}

const STATE_CLASSES: Record<QueryMonitorState, string> = {
  ok: "bg-emerald-500/10 text-success",
  breaching: "bg-red-500/10 text-danger",
  // Deliberately neutral rather than red: an unknown monitor is broken, not
  // breaching, and colouring the two alike is exactly the confusion the state
  // exists to prevent.
  unknown: "bg-surface-overlay text-on-surface-tertiary",
};

function stateLabel(gt: Gt, state: QueryMonitorState): string {
  switch (state) {
    case "ok":
      return gt("OK");
    case "breaching":
      return gt("Breaching");
    case "unknown":
      return gt("Not known");
  }
}

function emptyDraft(target: TargetChoice): Draft {
  return {
    name: "",
    description: "",
    accountId: target.accountId,
    resourceId: target.resourceId,
    resourceTypeId: target.resourceTypeId,
    sql: "SELECT count(*) FROM ",
    mode: "scalar",
    operator: "gt",
    threshold: 0,
    intervalMinutes: 15,
    consecutiveBreaches: 1,
    enabled: true,
  };
}

function draftFrom(monitor: QueryMonitor): Draft {
  return {
    name: monitor.name,
    description: monitor.description ?? "",
    accountId: monitor.accountId,
    resourceId: monitor.resourceId,
    resourceTypeId: monitor.resourceTypeId,
    sql: monitor.sql,
    mode: monitor.mode,
    operator: monitor.operator,
    threshold: monitor.threshold,
    intervalMinutes: monitor.intervalMinutes,
    consecutiveBreaches: monitor.consecutiveBreaches,
    enabled: monitor.enabled,
  };
}

function toInput(draft: Draft): QueryMonitorInput {
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    accountId: draft.accountId,
    // Sent even when null, so switching a monitor from a resource back to its
    // account actually clears the scope on save.
    resourceId: draft.resourceId,
    resourceTypeId: draft.resourceTypeId,
    sql: draft.sql,
    mode: draft.mode,
    operator: draft.operator,
    threshold: draft.threshold,
    intervalMinutes: draft.intervalMinutes,
    consecutiveBreaches: draft.consecutiveBreaches,
    enabled: draft.enabled,
  };
}

/**
 * Query monitors — a SQL query on a schedule, with a threshold.
 *
 * The editor's live SQL guard is the same function the server enforces on every
 * execution, so somebody typing `DELETE` sees the refusal as they type rather
 * than on save.
 */
export function QueryMonitorsSection({
  monitors,
  error,
  onRetry,
  targetOptions,
  onCreate,
  onUpdate,
  onDelete,
  onTest,
}: QueryMonitorsSectionProps) {
  const gt = useGT();
  const targets = targetOptions ?? [];
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<QueryMonitorTestResult | null>(null);

  const canEdit = Boolean(onCreate || onUpdate || onDelete);
  // Recomputed as the user types, from the same guard the server runs.
  const sqlWarning = useMemo(() => (draft ? monitorSqlProblem(draft.sql) : null), [draft]);

  // The picker, one optgroup per account: the account's own connection when it
  // has a SQL driver, then each SQL-capable resource inside it.
  const targetGroups = useMemo(
    () =>
      targets.map((account) => ({
        id: account.id,
        name: account.name,
        choices: [
          ...(account.accountSql
            ? [
                {
                  key: targetKey(account.id, null),
                  accountId: account.id,
                  resourceId: null,
                  resourceTypeId: null,
                  label: gt("Entire account"),
                } satisfies TargetChoice,
              ]
            : []),
          ...account.resources.map(
            (resource) =>
              ({
                key: targetKey(account.id, resource.id),
                accountId: account.id,
                resourceId: resource.id,
                resourceTypeId: resource.resourceTypeId,
                label: `${resource.name} · ${resource.typeName}`,
              }) satisfies TargetChoice,
          ),
        ],
      })),
    [targets, gt],
  );
  const targetChoices = useMemo(() => targetGroups.flatMap((g) => g.choices), [targetGroups]);

  // A monitor can point at a target the picker no longer offers — the resource
  // was deleted, or the monitor was created over the API against something the
  // picker does not enumerate. Editing it must not silently reassign the
  // query, so the current target is kept selectable under its stored name.
  const editingMonitor =
    editingId != null ? (monitors?.find((m) => m.id === editingId) ?? null) : null;
  const draftTargetKey = draft ? targetKey(draft.accountId, draft.resourceId) : null;
  // Derived from the monitor rather than the draft, so switching the select
  // away and back does not make the stored target vanish mid-edit.
  const monitorTargetKey = editingMonitor
    ? targetKey(editingMonitor.accountId, editingMonitor.resourceId)
    : null;
  const orphanTarget: TargetChoice | null =
    editingMonitor && monitorTargetKey && !targetChoices.some((c) => c.key === monitorTargetKey)
      ? {
          key: monitorTargetKey,
          accountId: editingMonitor.accountId,
          resourceId: editingMonitor.resourceId,
          resourceTypeId: editingMonitor.resourceTypeId,
          label: editingMonitor.resourceId
            ? (editingMonitor.resourceName ?? gt("Current resource"))
            : (editingMonitor.accountName ?? gt("Current account")),
        }
      : null;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      setDraft(null);
      setEditingId(null);
      setTestResult(null);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (!draft) return;
    const input = toInput(draft);
    const problem = validateQueryMonitor(input);
    if (problem) {
      setActionError(problem);
      return;
    }
    if (editingId && onUpdate) void run(() => onUpdate(editingId, input));
    else if (!editingId && onCreate) void run(() => onCreate(input));
  }

  async function test() {
    if (!draft || !onTest) return;
    setBusy(true);
    setActionError(null);
    try {
      setTestResult(await onTest(toInput(draft)));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <h1 className="text-xl font-semibold mb-1">{gt("Query monitors")}</h1>
      <T>
        <p className="text-sm text-on-surface-muted mb-6">
          Metric alerts watch what your provider reports. This watches what your data says — the
          orders table that stopped growing, the dead-letter queue with four thousand rows in it,
          yesterday's ETL that wrote nothing. One read-only query, on a schedule, with a threshold.
        </p>
      </T>

      {error != null && monitors === null && (
        <div role="alert" className="text-sm text-danger">
          {gt("Couldn't load the monitors — {error}", { error })}{" "}
          {onRetry && (
            <button type="button" onClick={onRetry} className="underline">
              {gt("Retry")}
            </button>
          )}
        </div>
      )}
      {monitors === null && error == null && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Loading monitors…")}
        </p>
      )}

      {actionError != null && (
        <p role="alert" className="mb-4 text-xs text-danger">
          {actionError}
        </p>
      )}

      {monitors !== null && (
        <>
          {canEdit && draft === null && (
            <button
              type="button"
              disabled={targetChoices.length === 0}
              onClick={() => {
                const first = targetChoices[0];
                if (!first) return;
                setDraft(emptyDraft(first));
                setEditingId(null);
                setTestResult(null);
              }}
              className="mb-4 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent disabled:opacity-50"
            >
              {targetChoices.length === 0
                ? gt("Connect a database account first")
                : gt("New monitor")}
            </button>
          )}

          {draft !== null && (
            <div className="mb-4 flex flex-col gap-3 rounded-xl border border-border p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
                  {gt("Name")}
                  <input
                    value={draft.name}
                    maxLength={QUERY_MONITOR_LIMITS.maxNameLength}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    placeholder={gt("Dead letters piling up")}
                    className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-on-surface"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
                  {gt("Run against")}
                  <select
                    value={draftTargetKey ?? ""}
                    onChange={(e) => {
                      const choice =
                        orphanTarget && orphanTarget.key === e.target.value
                          ? orphanTarget
                          : targetChoices.find((c) => c.key === e.target.value);
                      if (choice) {
                        setDraft({
                          ...draft,
                          accountId: choice.accountId,
                          resourceId: choice.resourceId,
                          resourceTypeId: choice.resourceTypeId,
                        });
                      }
                    }}
                    className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-on-surface"
                  >
                    {orphanTarget && <option value={orphanTarget.key}>{orphanTarget.label}</option>}
                    {targetGroups.map((group) => (
                      <optgroup key={group.id} label={group.name}>
                        {group.choices.map((choice) => (
                          <option key={choice.key} value={choice.key}>
                            {choice.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
              </div>

              <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
                {gt("Query (read-only, one statement)")}
                <textarea
                  value={draft.sql}
                  maxLength={QUERY_MONITOR_LIMITS.maxSqlLength}
                  onChange={(e) => setDraft({ ...draft, sql: e.target.value })}
                  rows={4}
                  spellCheck={false}
                  className="rounded-lg border border-border bg-surface px-2.5 py-1.5 font-mono text-xs text-on-surface"
                />
              </label>
              {sqlWarning && (
                <p role="alert" className="text-xs text-warning">
                  {sqlWarning}
                </p>
              )}

              <div className="grid gap-3 sm:grid-cols-4">
                <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
                  {gt("Measure")}
                  <select
                    value={draft.mode}
                    onChange={(e) =>
                      setDraft({ ...draft, mode: e.target.value as QueryMonitorMode })
                    }
                    className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface"
                  >
                    <option value="scalar">{gt("First value")}</option>
                    <option value="rowCount">{gt("Row count")}</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
                  {gt("Alert when")}
                  <select
                    value={draft.operator}
                    onChange={(e) =>
                      setDraft({ ...draft, operator: e.target.value as QueryMonitorOperator })
                    }
                    className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface"
                  >
                    {(Object.keys(QUERY_MONITOR_OPERATOR_LABELS) as QueryMonitorOperator[]).map(
                      (op) => (
                        <option key={op} value={op}>
                          {QUERY_MONITOR_OPERATOR_LABELS[op]}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
                  {gt("Threshold")}
                  <input
                    type="number"
                    value={draft.threshold}
                    onChange={(e) => setDraft({ ...draft, threshold: Number(e.target.value) })}
                    className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
                  {gt("Every (minutes)")}
                  <input
                    type="number"
                    min={QUERY_MONITOR_LIMITS.minIntervalMinutes}
                    value={draft.intervalMinutes}
                    onChange={(e) =>
                      setDraft({ ...draft, intervalMinutes: Number(e.target.value) })
                    }
                    className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface"
                  />
                </label>
              </div>

              <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
                {gt("Breach this many runs in a row before alerting")}
                <input
                  type="number"
                  min={QUERY_MONITOR_LIMITS.minConsecutiveBreaches}
                  max={QUERY_MONITOR_LIMITS.maxConsecutiveBreaches}
                  value={draft.consecutiveBreaches}
                  onChange={(e) =>
                    setDraft({ ...draft, consecutiveBreaches: Number(e.target.value) })
                  }
                  className="w-24 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface"
                />
              </label>

              {testResult && (
                <div className="rounded-lg border border-border p-3 text-xs">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className={`rounded-full px-2 py-0.5 ${STATE_CLASSES[testResult.state]}`}>
                      {stateLabel(gt, testResult.state)}
                    </span>
                    <span className="text-on-surface">
                      {testResult.value === null
                        ? gt("no comparable value")
                        : gt("value {value}", { value: testResult.value })}
                    </span>
                    <span className="text-on-surface-faint">
                      {gt("{ms}ms", { ms: testResult.durationMs })}
                    </span>
                  </div>
                  {testResult.error && <p className="mt-1 text-danger">{testResult.error}</p>}
                  {testResult.rows.length > 0 && (
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-on-surface-tertiary">
                      {JSON.stringify(testResult.rows.slice(0, 5), null, 2)}
                    </pre>
                  )}
                </div>
              )}

              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={save}
                  className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent disabled:opacity-50"
                >
                  {gt("Save")}
                </button>
                {onTest && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void test()}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs text-on-surface-tertiary disabled:opacity-50"
                  >
                    {gt("Try it")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setDraft(null);
                    setEditingId(null);
                    setTestResult(null);
                    setActionError(null);
                  }}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs text-on-surface-tertiary"
                >
                  {gt("Cancel")}
                </button>
              </div>
            </div>
          )}

          {monitors.length === 0 ? (
            <T>
              <p className="text-sm text-on-surface-faint">
                No monitors yet. A good first one is the query you run by hand every morning.
              </p>
            </T>
          ) : (
            <ul className="flex flex-col gap-2">
              {monitors.map((monitor) => (
                <li key={monitor.id} className="rounded-xl border border-border p-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-sm font-medium text-on-surface">{monitor.name}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${STATE_CLASSES[monitor.state]}`}
                    >
                      {stateLabel(gt, monitor.state)}
                    </span>
                    {!monitor.enabled && (
                      <span className="rounded-full bg-surface-overlay px-2 py-0.5 text-xs text-on-surface-faint">
                        {gt("Paused")}
                      </span>
                    )}
                    <span className="text-xs text-on-surface-tertiary">
                      {describeQueryMonitor(monitor)}
                      {monitor.resourceName ? ` · ${monitor.resourceName}` : ""}
                      {monitor.accountName ? ` · ${monitor.accountName}` : ""}
                    </span>
                    <span className="text-xs tabular-nums text-on-surface-faint">
                      {monitor.lastValue === null
                        ? gt("no value yet")
                        : gt("last {value}", { value: monitor.lastValue })}
                      {monitor.lastRunAt
                        ? ` · ${new Date(monitor.lastRunAt).toLocaleString()}`
                        : ""}
                    </span>
                    <div className="ml-auto flex gap-2">
                      {onUpdate && (
                        <button
                          type="button"
                          onClick={() => {
                            setDraft(draftFrom(monitor));
                            setEditingId(monitor.id);
                            setTestResult(null);
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
                          onClick={() => void run(() => onDelete(monitor.id))}
                          className="text-xs text-danger underline disabled:opacity-50"
                        >
                          {gt("Delete")}
                        </button>
                      )}
                    </div>
                  </div>

                  {monitor.description && (
                    <p className="mt-1 text-xs text-on-surface-tertiary">{monitor.description}</p>
                  )}
                  {monitor.lastError && (
                    // The driver's own message, deliberately: "relation does
                    // not exist" is the single most useful thing this page can
                    // say, and a generic failure would make every broken
                    // monitor look alike.
                    <p className="mt-1 text-xs text-warning">{monitor.lastError}</p>
                  )}
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-on-surface-faint">
                    {monitor.sql}
                  </pre>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
