import { AUTOSCALING_BOUNDS } from "./resource-types.js";
import type { BasetenAutoscaling } from "./types.js";

/** Host field key → Baseten autoscaling property. */
export const AUTOSCALING_KEYS: Record<keyof typeof AUTOSCALING_BOUNDS, keyof BasetenAutoscaling> = {
  minReplica: "min_replica",
  maxReplica: "max_replica",
  concurrencyTarget: "concurrency_target",
  targetUtilization: "target_utilization_percentage",
  autoscalingWindow: "autoscaling_window",
  scaleDownDelay: "scale_down_delay",
  targetInFlightTokens: "target_in_flight_tokens",
};

const LABELS: Record<keyof typeof AUTOSCALING_BOUNDS, string> = {
  minReplica: "Min replicas",
  maxReplica: "Max replicas",
  concurrencyTarget: "Concurrency target",
  targetUtilization: "Target utilization",
  autoscalingWindow: "Autoscaling window",
  scaleDownDelay: "Scale-down delay",
  targetInFlightTokens: "Target in-flight tokens",
};

/**
 * Validate the changed autoscaling fields against Baseten's documented bounds
 * and against each other (min ≤ max, using the current value for whichever
 * side was not edited), and build the PATCH body. Throws a readable error;
 * returns `null` when no autoscaling field changed.
 *
 * `development` deployments are pinned to 0 or 1 replica by Baseten.
 */
export function buildAutoscalingPatch(
  changed: Record<string, string>,
  current: Record<string, string | number | boolean | undefined>,
  opts: { development?: boolean } = {},
): Partial<Record<keyof BasetenAutoscaling, number>> | null {
  const body: Partial<Record<keyof BasetenAutoscaling, number>> = {};
  const errors: string[] = [];
  for (const key of Object.keys(AUTOSCALING_KEYS) as Array<keyof typeof AUTOSCALING_KEYS>) {
    const raw = changed[key];
    if (raw === undefined || String(raw).trim() === "") continue;
    const n = Number(raw);
    const bounds: { min: number; max?: number } = AUTOSCALING_BOUNDS[key];
    if (!Number.isInteger(n)) {
      errors.push(`${LABELS[key]} must be a whole number.`);
      continue;
    }
    if (n < bounds.min || (bounds.max !== undefined && n > bounds.max)) {
      errors.push(
        bounds.max !== undefined
          ? `${LABELS[key]} must be between ${bounds.min} and ${bounds.max}.`
          : `${LABELS[key]} must be at least ${bounds.min}.`,
      );
      continue;
    }
    body[AUTOSCALING_KEYS[key]] = n;
  }
  const pick = (patchKey: "min_replica" | "max_replica", fieldKey: string) => {
    if (body[patchKey] !== undefined) return body[patchKey];
    const v = Number(current[fieldKey]);
    return Number.isFinite(v) && current[fieldKey] !== undefined && current[fieldKey] !== ""
      ? v
      : undefined;
  };
  const min = pick("min_replica", "minReplica");
  const max = pick("max_replica", "maxReplica");
  if (min !== undefined && max !== undefined && min > max) {
    errors.push(`Min replicas (${min}) cannot be above max replicas (${max}).`);
  }
  if (opts.development && ((min ?? 0) > 1 || (max ?? 1) > 1)) {
    errors.push(
      "A development deployment can only run 0 or 1 replica. Promote it to scale further.",
    );
  }
  if (errors.length) throw new Error(errors.join(" "));
  return Object.keys(body).length ? body : null;
}
