import { useMemo, useState } from "react";
import { T, useGT } from "gt-react";
import {
  MAINTENANCE_LIMITS,
  describeMaintenanceOrder,
  plannedResourceCount,
  type DependencyGraphData,
  type MaintenanceIntent,
  type MaintenancePlan,
} from "@infrawrench/client-core";

export interface MaintenancePlanSectionProps {
  /** The graph the picker chooses from — the same one the canvas above draws. */
  graph: DependencyGraphData;
  /** Ask the server for a plan. The ordering is computed there, once. */
  onPlan: (input: { intent: MaintenanceIntent; resourceIds: string[] }) => Promise<MaintenancePlan>;
  onOpenResource?: ((resourceId: string) => void) | undefined;
}

/**
 * The maintenance planner, beneath the dependency graph it reads.
 *
 * It sits here rather than on its own page because the answer only makes sense
 * next to the picture that produced it: somebody looking at the wiring is the
 * person about to ask what order to touch it in.
 *
 * Nothing on this panel performs an action. It orders, it names the collateral,
 * and it links to each resource so the operator does the work — which is the
 * feature's boundary, not a gap in it.
 */
export function MaintenancePlanSection({
  graph,
  onPlan,
  onOpenResource,
}: MaintenancePlanSectionProps) {
  const gt = useGT();
  const [intent, setIntent] = useState<MaintenanceIntent>("restart");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [plan, setPlan] = useState<MaintenancePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return graph.nodes
      .filter((node) => !needle || node.displayName.toLowerCase().includes(needle))
      .slice(0, 200);
  }, [graph.nodes, filter]);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAINTENANCE_LIMITS.maxSelection) next.add(id);
      return next;
    });
    // The plan is about the previous selection the moment the selection moves;
    // keeping it on screen would let somebody read an order for a set they are
    // no longer planning.
    setPlan(null);
  }

  async function computePlan() {
    if (selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      setPlan(await onPlan({ intent, resourceIds: [...selected] }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 border-t border-border p-6">
      <div>
        <h2 className="text-lg font-semibold text-on-surface">{gt("Plan a maintenance window")}</h2>
        <T>
          <p className="mt-0.5 text-sm text-on-surface-muted">
            Pick what you are about to touch and this will put it in an order that respects the
            wiring above — and tell you what each step takes down with it. It does not do anything:
            you run the steps.
          </p>
        </T>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
          {gt("Doing what")}
          <select
            value={intent}
            onChange={(e) => {
              setIntent(e.target.value as MaintenanceIntent);
              setPlan(null);
            }}
            className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-on-surface"
          >
            <option value="restart">{gt("Restarting")}</option>
            <option value="stop">{gt("Stopping")}</option>
            <option value="start">{gt("Starting")}</option>
          </select>
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-on-surface-tertiary">
          {gt("Find resources")}
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={gt("Filter by name")}
            className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-on-surface"
          />
        </label>
        <button
          type="button"
          disabled={busy || selected.size === 0}
          onClick={() => void computePlan()}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent disabled:opacity-50"
        >
          {gt("Work out the order ({count})", { count: selected.size })}
        </button>
      </div>

      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}

      <div className="flex max-h-48 flex-wrap gap-1.5 overflow-auto text-xs">
        {options.map((node) => {
          const on = selected.has(node.id);
          return (
            <button
              key={node.id}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(node.id)}
              className={`rounded-full border px-2.5 py-1 transition-colors ${
                on
                  ? "border-transparent bg-surface-overlay text-on-surface"
                  : "border-border text-on-surface-tertiary hover:text-on-surface-secondary"
              }`}
            >
              {node.displayName}
            </button>
          );
        })}
        {options.length === 0 && (
          <span className="text-on-surface-faint">{gt("Nothing matches that filter.")}</span>
        )}
      </div>

      {plan !== null && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-on-surface-tertiary">
            {describeMaintenanceOrder(plan.intent)}{" "}
            {gt("{count} resources in {steps} steps.", {
              count: plannedResourceCount(plan),
              steps: plan.steps.length,
            })}
          </p>

          {plan.partialGraph && (
            <p role="alert" className="text-xs text-warning">
              {gt(
                "The dependency graph was truncated, so this order is a best effort over a partial picture.",
              )}
            </p>
          )}

          {plan.cyclic.length > 0 && (
            <p role="alert" className="text-xs text-warning">
              {gt(
                "These depend on each other in a loop, so there is no safe order for them: {names}. Decide it yourself.",
                { names: plan.cyclic.map((c) => c.label).join(", ") },
              )}
            </p>
          )}

          {plan.unknown.length > 0 && (
            <p className="text-xs text-on-surface-faint">
              {gt("{count} selected resources are no longer in the graph and were left out.", {
                count: plan.unknown.length,
              })}
            </p>
          )}

          <ol className="flex flex-col gap-2">
            {plan.steps.map((step) => (
              <li key={step.position} className="rounded-xl border border-border p-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-xs tabular-nums text-on-surface-faint">
                    {gt("Step {n}", { n: step.position })}
                  </span>
                  {step.resourceIds.map((id, index) =>
                    onOpenResource ? (
                      <button
                        key={id}
                        type="button"
                        onClick={() => onOpenResource(id)}
                        className="text-sm text-on-surface underline-offset-2 hover:underline"
                      >
                        {step.labels[index]}
                      </button>
                    ) : (
                      <span key={id} className="text-sm text-on-surface">
                        {step.labels[index]}
                      </span>
                    ),
                  )}
                  {step.resourceIds.length > 1 && (
                    <span className="text-xs text-on-surface-faint">
                      {gt("(independent — can go together)")}
                    </span>
                  )}
                </div>
                {step.affectsOutside.length > 0 && (
                  <p className="mt-1 text-xs text-warning">
                    {gt("Also affects: {names}", {
                      names: step.affectsOutside.map((i) => i.label).join(", "),
                    })}
                  </p>
                )}
              </li>
            ))}
          </ol>

          {plan.steps.length === 0 && plan.cyclic.length === 0 && (
            <p className="text-xs text-on-surface-faint">{gt("Nothing to order.")}</p>
          )}
        </div>
      )}
    </div>
  );
}
