import { clamp, isRecord } from "../util/bytes.js";

/**
 * A plan, as a pull request shows it: what `terraform show -json <planfile>`
 * says will happen, without any of the values.
 *
 * The plan document holds every attribute before and after, sensitive ones in
 * the clear (`before_sensitive` only marks them), so it is read once, reduced
 * to this and thrown away. A summary names attributes and never carries a
 * value, which is what lets it be stored on the run and shown to anyone who
 * can read the repository.
 *
 * The document comes from a CI job, which ran the repository's own code, so
 * it is untrusted: every list is capped, every string clamped, and nothing
 * recurses deeper than {@link MAX_DEPTH}.
 */

/** `terraform show -json` major versions this reads. 1.x so far. */
const SUPPORTED_MAJOR = "1";

export const MAX_PLAN_RESOURCES = 2000;
export const MAX_PLAN_OUTPUTS = 500;
export const MAX_PLAN_ATTRIBUTES = 64;
const MAX_REPLACE_PATHS = 16;
const MAX_NAME = 512;
const MAX_DEPTH = 64;

/**
 * What happens to one resource instance. Terraform's `actions` list is folded
 * to one word: `["delete","create"]` and `["create","delete"]` are a replace.
 */
export type PlanAction = "create" | "update" | "delete" | "replace" | "read" | "forget" | "no-op";

export interface PlanAttributeChange {
  /** The top-level attribute's name. Never its value. */
  readonly name: string;
  /** The provider only knows the new value after the apply. */
  readonly unknown: boolean;
  readonly sensitive: boolean;
}

export interface PlanResourceChange {
  /** `module.vpc.aws_subnet.private[0]` */
  readonly address: string;
  readonly moduleAddress: string | null;
  readonly mode: "managed" | "data";
  readonly type: string;
  readonly name: string;
  /** `registry.terraform.io/hashicorp/aws` */
  readonly provider: string | null;
  readonly action: PlanAction;
  /** For a replace: whether the new instance exists before the old one goes. */
  readonly createBeforeDestroy: boolean;
  /** Terraform's `action_reason`, as it wrote it (`replace_because_tainted`). */
  readonly reason: string | null;
  /** Attribute paths that force the replacement (`ami`, `ebs_block_device[0].size`). */
  readonly replacePaths: readonly string[];
  /** For an update or a replace: which top-level attributes differ. */
  readonly attributes: readonly PlanAttributeChange[];
  /** Attributes past {@link MAX_PLAN_ATTRIBUTES} that changed too. */
  readonly attributesOmitted: number;
  /** Set when a `moved` block (or a rename Terraform followed) brought it here. */
  readonly movedFrom: string | null;
  /** Set when the plan imports it (an `import` block). */
  readonly imported: boolean;
}

export interface PlanOutputChange {
  readonly name: string;
  readonly action: PlanAction;
  readonly sensitive: boolean;
}

export interface PlanCounts {
  readonly create: number;
  readonly update: number;
  readonly delete: number;
  readonly replace: number;
  readonly forget: number;
  /** Instances that only move address or are only imported are counted here, not as changes. */
  readonly move: number;
  readonly import: number;
}

export interface PlanSummary {
  readonly formatVersion: string;
  readonly terraformVersion: string | null;
  /** Terraform's own line: "Plan: 2 to add, 1 to change, 2 to destroy." */
  readonly add: number;
  readonly change: number;
  readonly destroy: number;
  readonly counts: PlanCounts;
  /** Whether applying would change anything: resources, outputs, moves or imports. */
  readonly hasChanges: boolean;
  /** False for a plan Terraform says cannot be applied (it errored, or it is partial). */
  readonly applyable: boolean;
  readonly errored: boolean;
  /** Everything that is not a no-op, in the plan's order, plus moves and imports. */
  readonly resources: readonly PlanResourceChange[];
  /** Changes past {@link MAX_PLAN_RESOURCES}. They are counted above all the same. */
  readonly resourcesOmitted: number;
  readonly outputs: readonly PlanOutputChange[];
  readonly outputsOmitted: number;
  /**
   * What Terraform found changed outside of it while refreshing, where that
   * bears on the plan (`resource_drift`). The same shape as `resources`.
   */
  readonly drift: readonly PlanResourceChange[];
  readonly driftOmitted: number;
}

export class PlanFormatError extends Error {
  override readonly name = "PlanFormatError";
}

function text(value: unknown): string | null {
  return typeof value === "string" ? clamp(value, MAX_NAME) : null;
}

/** Terraform's `actions` list as one action. Unknown lists read as an update: never as nothing. */
export function foldActions(actions: unknown): {
  action: PlanAction;
  createBeforeDestroy: boolean;
} {
  const list = Array.isArray(actions) ? actions.filter((a) => typeof a === "string") : [];
  const none = { createBeforeDestroy: false };
  if (list.length === 2 && list.includes("create") && list.includes("delete")) {
    return { action: "replace", createBeforeDestroy: list[0] === "create" };
  }
  if (list.length === 2 && list.includes("create") && list.includes("forget")) {
    return { action: "replace", createBeforeDestroy: list[0] === "create" };
  }
  switch (list.length === 1 ? list[0] : undefined) {
    case "no-op":
      return { action: "no-op", ...none };
    case "create":
      return { action: "create", ...none };
    case "update":
      return { action: "update", ...none };
    case "delete":
      return { action: "delete", ...none };
    case "read":
      return { action: "read", ...none };
    case "forget":
      return { action: "forget", ...none };
    default:
      return { action: list.length === 0 ? "no-op" : "update", ...none };
  }
}

/** Structural equality with a depth bound. Past the bound two values count as different. */
function same(a: unknown, b: unknown, depth: number): boolean {
  if (a === b) return true;
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i], depth + 1)) return false;
    return true;
  }
  if (isRecord(a)) {
    if (!isRecord(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(b, key) || !same(a[key], b[key], depth + 1)) return false;
    }
    return true;
  }
  return false;
}

/** Whether a `*_sensitive` or `after_unknown` mirror marks anything at or under a key. */
function marked(mirror: unknown, depth = 0): boolean {
  if (mirror === true) return true;
  if (depth > MAX_DEPTH) return true;
  if (Array.isArray(mirror)) return mirror.some((item) => marked(item, depth + 1));
  if (isRecord(mirror)) return Object.values(mirror).some((item) => marked(item, depth + 1));
  return false;
}

function attributeChanges(change: Record<string, unknown>): {
  attributes: PlanAttributeChange[];
  omitted: number;
} {
  const before = isRecord(change["before"]) ? change["before"] : {};
  const after = isRecord(change["after"]) ? change["after"] : {};
  const unknown = isRecord(change["after_unknown"]) ? change["after_unknown"] : {};
  const beforeSensitive = isRecord(change["before_sensitive"]) ? change["before_sensitive"] : {};
  const afterSensitive = isRecord(change["after_sensitive"]) ? change["after_sensitive"] : {};

  const attributes: PlanAttributeChange[] = [];
  let omitted = 0;
  const names = new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(unknown)]);
  for (const name of [...names].sort()) {
    const isUnknown = marked(unknown[name]);
    if (!isUnknown && same(before[name], after[name], 0)) continue;
    if (attributes.length >= MAX_PLAN_ATTRIBUTES) {
      omitted += 1;
      continue;
    }
    attributes.push({
      name: clamp(name, MAX_NAME),
      unknown: isUnknown,
      sensitive: marked(beforeSensitive[name]) || marked(afterSensitive[name]),
    });
  }
  return { attributes, omitted };
}

/** `[["ebs_block_device", 0, "size"]]` as `ebs_block_device[0].size`. */
function replacePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const path of value.slice(0, MAX_REPLACE_PATHS)) {
    if (!Array.isArray(path)) continue;
    let rendered = "";
    for (const step of path.slice(0, MAX_DEPTH)) {
      if (typeof step === "number") rendered += `[${step}]`;
      else if (typeof step === "string") {
        rendered += /^[A-Za-z_][A-Za-z0-9_-]*$/.test(step)
          ? `${rendered ? "." : ""}${step}`
          : `[${JSON.stringify(step)}]`;
      }
    }
    if (rendered) out.push(clamp(rendered, MAX_NAME));
  }
  return out;
}

function resourceChange(entry: unknown): PlanResourceChange | null {
  if (!isRecord(entry)) return null;
  const address = text(entry["address"]);
  const change = entry["change"];
  if (address === null || !isRecord(change)) return null;
  const { action, createBeforeDestroy } = foldActions(change["actions"]);
  const detailed = action === "update" || action === "replace";
  const { attributes, omitted } = detailed
    ? attributeChanges(change)
    : { attributes: [], omitted: 0 };
  return {
    address,
    moduleAddress: text(entry["module_address"]),
    mode: entry["mode"] === "data" ? "data" : "managed",
    type: text(entry["type"]) ?? "",
    name: text(entry["name"]) ?? "",
    provider: text(entry["provider_name"]),
    action,
    createBeforeDestroy,
    reason: text(entry["action_reason"]),
    replacePaths: action === "replace" ? replacePaths(change["replace_paths"]) : [],
    attributes,
    attributesOmitted: omitted,
    movedFrom: text(entry["previous_address"]),
    imported: isRecord(change["importing"]),
  };
}

/**
 * Reduces a parsed `terraform show -json <planfile>` document. Throws
 * {@link PlanFormatError} for anything that is not one, a state document
 * (`terraform show -json` without a plan file) included.
 */
export function summarizePlan(document: unknown): PlanSummary {
  if (!isRecord(document)) throw new PlanFormatError("The plan is not a JSON object.");
  const formatVersion = document["format_version"];
  if (typeof formatVersion !== "string") {
    throw new PlanFormatError("This is not `terraform show -json` output: no format_version.");
  }
  if (formatVersion.split(".")[0] !== SUPPORTED_MAJOR) {
    throw new PlanFormatError(`Plan format ${clamp(formatVersion, 16)} is not supported.`);
  }
  if (!("resource_changes" in document) && !("planned_values" in document)) {
    throw new PlanFormatError(
      "This is a state, not a plan: run `terraform show -json` on the plan file.",
    );
  }

  const counts = { create: 0, update: 0, delete: 0, replace: 0, forget: 0, move: 0, import: 0 };
  const resources: PlanResourceChange[] = [];
  let resourcesOmitted = 0;
  const changes = Array.isArray(document["resource_changes"]) ? document["resource_changes"] : [];
  for (const entry of changes) {
    const change = resourceChange(entry);
    // Data sources are read on every plan; they are not changes to anything.
    if (!change || change.mode === "data") continue;
    if (change.imported) counts.import += 1;
    if (change.movedFrom !== null) counts.move += 1;
    if (change.action === "no-op" || change.action === "read") {
      if (change.movedFrom === null && !change.imported) continue;
    } else {
      counts[change.action] += 1;
    }
    if (resources.length < MAX_PLAN_RESOURCES) resources.push(change);
    else resourcesOmitted += 1;
  }

  const outputs: PlanOutputChange[] = [];
  let outputsOmitted = 0;
  const outputChanges = isRecord(document["output_changes"]) ? document["output_changes"] : {};
  for (const name of Object.keys(outputChanges).sort()) {
    const change = outputChanges[name];
    if (!isRecord(change)) continue;
    const { action } = foldActions(change["actions"]);
    if (action === "no-op") continue;
    if (outputs.length >= MAX_PLAN_OUTPUTS) {
      outputsOmitted += 1;
      continue;
    }
    outputs.push({
      name: clamp(name, MAX_NAME),
      action,
      sensitive: marked(change["before_sensitive"]) || marked(change["after_sensitive"]),
    });
  }

  const drift: PlanResourceChange[] = [];
  let driftOmitted = 0;
  const drifted = Array.isArray(document["resource_drift"]) ? document["resource_drift"] : [];
  for (const entry of drifted) {
    const change = resourceChange(entry);
    if (!change || change.action === "no-op") continue;
    if (drift.length < MAX_PLAN_RESOURCES) drift.push(change);
    else driftOmitted += 1;
  }

  const errored = document["errored"] === true;
  const terraformVersion = text(document["terraform_version"]);
  return {
    formatVersion: clamp(formatVersion, 16),
    terraformVersion,
    add: counts.create + counts.replace,
    change: counts.update,
    destroy: counts.delete + counts.replace,
    counts,
    hasChanges:
      counts.create + counts.update + counts.delete + counts.replace + counts.forget > 0 ||
      counts.move + counts.import > 0 ||
      outputs.length + outputsOmitted > 0,
    // `applyable` is written since Terraform 1.8; before it, a plan that did not error applies.
    applyable: typeof document["applyable"] === "boolean" ? document["applyable"] : !errored,
    errored,
    resources,
    resourcesOmitted,
    outputs,
    outputsOmitted,
    drift,
    driftOmitted,
  };
}

/** What `action_reason` values mean, for the one line under a change. */
const REASONS: Record<string, string> = {
  replace_because_tainted: "the resource is tainted",
  replace_because_cannot_update: "a changed attribute cannot be updated in place",
  replace_by_request: "replacement was requested with -replace",
  replace_by_triggers: "a replace_triggered_by reference changed",
  delete_because_no_resource_config: "its resource block is gone from the configuration",
  delete_because_no_module: "its module is gone from the configuration",
  delete_because_wrong_repetition: "the block's count or for_each changed kind",
  delete_because_count_index: "its index is out of range for count",
  delete_because_each_key: "its key is not in for_each",
  delete_because_no_move_target: "it was moved to an address with no resource block",
  read_because_config_unknown: "its configuration is only known after the apply",
  read_because_dependency_pending: "something it depends on changes first",
  read_because_check_nested: "it belongs to a check block",
};

/** A reason in words, or null for one this does not know (show the raw value then). */
export function describeReason(reason: string | null): string | null {
  return reason === null ? null : (REASONS[reason] ?? null);
}

/** Terraform's closing line, from a summary. */
export function planLine(summary: PlanSummary): string {
  if (!summary.hasChanges) return "No changes.";
  return `Plan: ${summary.add} to add, ${summary.change} to change, ${summary.destroy} to destroy.`;
}
