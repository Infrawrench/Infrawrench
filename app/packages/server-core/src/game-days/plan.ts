/**
 * The dry run: what injecting a game day would do right now, changing
 * nothing. Each target's `prepareFailure` is the read the real inject makes
 * first, so the plan reports the provider's own view of the current state and
 * any target that could not even be prepared.
 */
import { and, eq } from "drizzle-orm";
import type { GameDayDetector, GameDayInput, GameDayPlan } from "@infrawrench/client-core";
import { db } from "../db/client";
import { serviceLinks } from "../db/schema";
import { findActiveChangeFreeze } from "../change-freezes";
import { prepareFailureTarget } from "./actions";
import { resolveGameDayInput } from "./store";

export async function planGameDay(
  organizationId: string,
  input: GameDayInput,
): Promise<GameDayPlan> {
  const targets = await resolveGameDayInput(organizationId, input);
  const steps = await Promise.all(
    targets.map(async (t) => {
      const base = {
        resourceId: t.resourceId,
        displayName: t.displayName,
        pluginId: t.pluginId,
        actionId: t.actionId,
        actionLabel: t.actionLabel,
        undoLabel: t.undoLabel,
      };
      try {
        const prepared = await prepareFailureTarget({ organizationId, ...t });
        return {
          ...base,
          outcome: prepared.alreadyInEffect ? ("skip" as const) : ("inject" as const),
          currentState: prepared.currentState ?? null,
          problem: null,
        };
      } catch (e) {
        return {
          ...base,
          outcome: "blocked" as const,
          currentState: null,
          problem: e instanceof Error ? e.message : String(e),
        };
      }
    }),
  );

  const freeze = await findActiveChangeFreeze(organizationId).catch(() => null);
  const unmeasured: GameDayDetector[] = [];
  if (input.watchedProbeIds.length === 0) unmeasured.push("probe_failure", "probe_alert");
  if (input.watchedSloIds.length === 0) {
    const linked = input.serviceId
      ? await db
          .select({ id: serviceLinks.targetId })
          .from(serviceLinks)
          .where(and(eq(serviceLinks.serviceId, input.serviceId), eq(serviceLinks.kind, "slo")))
          .limit(1)
      : [];
    if (linked.length === 0) unmeasured.push("slo_burn");
  }
  return {
    steps,
    blockingFreeze: freeze ? { id: freeze.id, name: freeze.name } : null,
    unmeasured,
  };
}
