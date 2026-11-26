import { clamp, isRecord } from "../util/bytes.js";
import { foldActions, type PlanAction } from "./summary.js";

/**
 * What pricing a plan needs from it, and nothing else: for each managed
 * resource that is created, changed or destroyed, its type and the plain
 * values of its top-level attributes before and after.
 *
 * Unlike a summary this **does carry values**, so it is not stored with the
 * run. The worker keeps it beside the workspace's state (the same bucket,
 * which already holds every value) until the app has priced it, then deletes
 * it. What is left out, so that nothing a provider marks secret travels:
 *
 * - every attribute the plan marks sensitive (`before_sensitive`,
 *   `after_sensitive`), in whole or in part;
 * - every attribute that is not a string, a number or a boolean (blocks,
 *   lists and maps: a price never depends on one the mappers can read);
 * - strings longer than {@link MAX_VALUE}, which sizes and regions never are
 *   and scripts and policies usually are;
 * - values only known after the apply.
 */

export type PricingLiteral = string | number | boolean;

export interface PlanPricingChange {
  readonly address: string;
  readonly type: string;
  readonly action: Exclude<PlanAction, "no-op" | "read" | "forget">;
  /** The instance as it is; null for a create. */
  readonly before: Readonly<Record<string, PricingLiteral>> | null;
  /** The instance as planned; null for a delete. */
  readonly after: Readonly<Record<string, PricingLiteral>> | null;
}

export interface PlanPricingInputs {
  readonly changes: readonly PlanPricingChange[];
  /** Changes past {@link MAX_PRICING_CHANGES}: the price is then partial. */
  readonly omitted: number;
}

export const MAX_PRICING_CHANGES = 200;
const MAX_ATTRIBUTES = 96;
const MAX_VALUE = 256;
const MAX_NAME = 512;

function literals(
  values: unknown,
  sensitive: unknown,
): Readonly<Record<string, PricingLiteral>> | null {
  if (!isRecord(values)) return null;
  const marked = isRecord(sensitive) ? sensitive : {};
  const out: Record<string, PricingLiteral> = {};
  let kept = 0;
  for (const [name, value] of Object.entries(values)) {
    if (kept >= MAX_ATTRIBUTES) break;
    // `true`, or a structure with a `true` somewhere inside: either way, not this one.
    const mark = marked[name];
    if (mark !== undefined && mark !== false) continue;
    if (name.length > MAX_NAME) continue;
    if (typeof value === "string") {
      if (value.length > MAX_VALUE) continue;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) continue;
    } else if (typeof value !== "boolean") {
      continue;
    }
    out[name] = value;
    kept++;
  }
  return out;
}

/** Reads `terraform show -json <planfile>` output. Never throws: a document it cannot read has no changes. */
export function planPricingInputs(document: unknown): PlanPricingInputs {
  const changes: PlanPricingChange[] = [];
  let omitted = 0;
  const list = isRecord(document) ? document["resource_changes"] : undefined;
  if (!Array.isArray(list)) return { changes, omitted };
  for (const entry of list) {
    if (!isRecord(entry) || entry["mode"] !== "managed") continue;
    const change = entry["change"];
    const address = entry["address"];
    const type = entry["type"];
    if (!isRecord(change) || typeof address !== "string" || typeof type !== "string") continue;
    const { action } = foldActions(change["actions"]);
    if (action === "no-op" || action === "read" || action === "forget") continue;
    if (changes.length >= MAX_PRICING_CHANGES) {
      omitted++;
      continue;
    }
    changes.push({
      address: clamp(address, MAX_NAME),
      type: clamp(type, MAX_NAME),
      action,
      before: action === "create" ? null : literals(change["before"], change["before_sensitive"]),
      after: action === "delete" ? null : literals(change["after"], change["after_sensitive"]),
    });
  }
  return { changes, omitted };
}
