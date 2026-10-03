/**
 * Form-field logic shared by every host that renders a `CreateFieldConfig[]`
 * — the create-resource modal, the prompt-nosql-command form, peer-pane
 * guidance CTAs. Pure: visibility rules and initial values, no widgets.
 */

import type { ShowWhenCondition, ShowWhenRule } from "@infrawrench/plugin-base";

/** The plugin contract's `ShowWhenRule`, under the name this module has always exported. */
export type ShowWhenRuleLike = ShowWhenRule;

function evaluateShowWhenCondition(
  cond: ShowWhenCondition,
  fields: Record<string, string>,
): boolean {
  const current = fields[cond.fieldKey] ?? "";
  if (cond.fieldValuesNot && cond.fieldValuesNot.length > 0) {
    if (cond.fieldValuesNot.includes(current)) return false;
  }
  if (cond.fieldValues && cond.fieldValues.length > 0) {
    return cond.fieldValues.includes(current);
  }
  if (cond.fieldValue !== undefined) {
    return current === cond.fieldValue;
  }
  // Only a `fieldValuesNot` constraint (or an empty condition) — the negative
  // check above already decided it; here it passed.
  return true;
}

/** Evaluate whether a create-form field should be visible based on showWhen conditions. */
export function evaluateShowWhen(
  field: { showWhen?: ShowWhenRuleLike },
  fields: Record<string, string>,
): boolean {
  const rule = field.showWhen;
  if (!rule) return true;
  if ("allOf" in rule) return rule.allOf.every((c) => evaluateShowWhenCondition(c, fields));
  if ("anyOf" in rule) return rule.anyOf.some((c) => evaluateShowWhenCondition(c, fields));
  return evaluateShowWhenCondition(rule, fields);
}

/** Build the initial field values from a CreateResourceConfig's field definitions. */
export function buildDefaultFields(
  configFields: Array<{
    key: string;
    kind: string;
    defaultValue?: string;
    defaultGb?: number;
    minGb?: number;
  }>,
): Record<string, string> {
  const init: Record<string, string> = {};
  for (const f of configFields) {
    if (f.defaultValue) init[f.key] = f.defaultValue;
    else if (f.kind === "disk-slider") init[f.key] = String(f.defaultGb ?? f.minGb ?? 20);
  }
  return init;
}
