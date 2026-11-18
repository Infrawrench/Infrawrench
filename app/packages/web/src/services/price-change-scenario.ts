/**
 * One-click scenario model from a price change: a USD model with one
 * recurring monthly amount (the change's monthly impact on the org's running
 * resources) from the day the new price takes effect, scoped to the change's
 * provider and the accounts running it. A trend forecast takes weeks to
 * learn a step in the run rate; the scenario shows it from the first day.
 *
 * The model is an ordinary scenario model once made: the user can rename,
 * edit or delete it in the scenario editor. The change keeps its id only
 * while it exists, so a deleted model can be made again.
 */
import { and, eq, isNull } from "drizzle-orm";
import {
  COST_SCENARIO_LIMITS,
  formatPriceChangePercent,
  priceChangeDay,
  priceChangePercent,
  priceChangeSentence,
  type CostScenarioModelInput,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { costScenarioModels, priceChangeEvents } from "../db/schema";
import { CostScenarioNameConflictError, createCostScenarioModel } from "./cost-scenarios";

/** Thrown for a change a scenario cannot be made from; routes map it to a 400. */
export class PriceChangeScenarioError extends Error {}

export interface PriceChangeScenarioResult {
  scenarioModelId: string;
  created: boolean;
}

/** The scenario input for a stored change. Exported for its test. */
export function priceChangeScenarioInput(
  row: Pick<
    typeof priceChangeEvents.$inferSelect,
    | "pluginId"
    | "platform"
    | "instanceType"
    | "region"
    | "oldHourlyUsd"
    | "newHourlyUsd"
    | "effectiveAt"
    | "monthlyImpactUsd"
    | "units"
    | "approximate"
    | "resources"
  >,
  now: Date,
): CostScenarioModelInput {
  const day = priceChangeDay(row.effectiveAt.toISOString());
  const percent = priceChangePercent(row.oldHourlyUsd, row.newHourlyUsd);
  const where = row.region && row.region !== "global" ? ` ${row.region}` : "";
  const name = `Price change: ${row.instanceType}${where} from ${day}`;
  const accountIds = [...new Set(row.resources.map((r) => r.accountId))];
  const sentence = priceChangeSentence({
    ...row,
    effectiveAt: row.effectiveAt.toISOString(),
    upcoming: row.effectiveAt.getTime() > now.getTime(),
  });
  return {
    name: name.slice(0, COST_SCENARIO_LIMITS.maxNameLength),
    description: `${sentence}.`.slice(0, COST_SCENARIO_LIMITS.maxDescriptionLength),
    currency: "USD",
    adjustments: [
      {
        id: "price-change",
        label: `${row.instanceType} list price ${formatPriceChangePercent(percent)}`.slice(
          0,
          COST_SCENARIO_LIMITS.maxLabelLength,
        ),
        kind: "recurring",
        startDate: day,
        endDate: null,
        amountCents: Math.round(row.monthlyImpactUsd * 100),
        currency: "USD",
        period: "monthly",
        percent: null,
        scope: [
          { dimension: "provider", op: "in", values: [row.pluginId] },
          ...(accountIds.length > 0
            ? [{ dimension: "account" as const, op: "in" as const, values: accountIds }]
            : []),
        ],
      },
    ],
  };
}

/** Make (or return) the change's scenario model. Null when the change is not this org's. */
export async function createPriceChangeScenario(
  organizationId: string,
  changeId: string,
  userId: string | null,
  now = new Date(),
): Promise<PriceChangeScenarioResult | null> {
  const [row] = await db
    .select()
    .from(priceChangeEvents)
    .where(
      and(eq(priceChangeEvents.organizationId, organizationId), eq(priceChangeEvents.id, changeId)),
    )
    .limit(1);
  if (!row) return null;

  if (row.scenarioModelId) {
    const [held] = await db
      .select({ id: costScenarioModels.id })
      .from(costScenarioModels)
      .where(
        and(
          eq(costScenarioModels.organizationId, organizationId),
          eq(costScenarioModels.id, row.scenarioModelId),
          isNull(costScenarioModels.deletedAt),
        ),
      )
      .limit(1);
    if (held) return { scenarioModelId: held.id, created: false };
  }

  const input = priceChangeScenarioInput(row, now);
  if (input.adjustments[0]?.amountCents === 0) {
    throw new PriceChangeScenarioError("This change does not move your monthly cost.");
  }
  let model;
  try {
    model = await createCostScenarioModel(organizationId, input, userId);
  } catch (error) {
    // Two changes of one type on one day, or a model the user renamed into
    // the way: tell them apart by the change's own id.
    if (!(error instanceof CostScenarioNameConflictError)) throw error;
    model = await createCostScenarioModel(
      organizationId,
      {
        ...input,
        name: `${input.name.slice(0, COST_SCENARIO_LIMITS.maxNameLength - 9)} (${row.id.slice(0, 6)})`,
      },
      userId,
    );
  }
  await db
    .update(priceChangeEvents)
    .set({ scenarioModelId: model.id, updatedAt: now })
    .where(eq(priceChangeEvents.id, row.id));
  return { scenarioModelId: model.id, created: true };
}
