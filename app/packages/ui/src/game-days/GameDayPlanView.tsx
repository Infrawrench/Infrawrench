import { useGT } from "gt-react";
import type { GameDayPlan } from "@infrawrench/client-core";
import { gameDayDetectorLabel } from "./labels.js";

/** The dry run: what injecting would do right now. */
export function GameDayPlanView({ plan }: { plan: GameDayPlan }) {
  const gt = useGT();
  return (
    <section
      aria-label={gt("Dry run")}
      className="rounded-xl border border-border bg-surface-raised p-3 text-sm"
    >
      <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-tertiary">
        {gt("Dry run")}
      </h3>
      {plan.blockingFreeze && (
        <p role="alert" className="mt-2 text-warning">
          {gt("The change freeze {name} is in effect: the game day would not start now.", {
            name: plan.blockingFreeze.name,
          })}
        </p>
      )}
      <ul className="mt-2 flex flex-col gap-1.5">
        {plan.steps.map((step) => (
          <li key={step.resourceId} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-on-surface">{step.displayName}</span>
            <span className="text-on-surface-secondary">{step.actionLabel}</span>
            {step.currentState && (
              <span className="text-xs text-on-surface-faint">
                {gt("now: {state}", { state: step.currentState })}
              </span>
            )}
            {step.outcome === "skip" && (
              <span className="text-xs text-warning">
                {gt("Already in that state: left alone")}
              </span>
            )}
            {step.outcome === "blocked" && (
              <span className="text-xs text-danger">
                {gt("Cannot run: {problem}", { problem: step.problem ?? "" })}
              </span>
            )}
            {step.outcome === "inject" && (
              <span className="text-xs text-on-surface-faint">
                {gt("Undo: {undo}", { undo: step.undoLabel })}
              </span>
            )}
          </li>
        ))}
      </ul>
      {plan.unmeasured.length > 0 && (
        <p className="mt-2 text-xs text-on-surface-faint">
          {gt("Nothing set up to measure: {detectors}", {
            detectors: plan.unmeasured.map((d) => gameDayDetectorLabel(d, gt)).join(", "),
          })}
        </p>
      )}
    </section>
  );
}
